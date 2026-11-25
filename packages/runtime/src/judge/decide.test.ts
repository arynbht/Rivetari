// The round's decision without a ledger: what the task judge writes and the
// judge eval scores.
import { describe, expect, it } from "vitest";

import { decideAfterReview, decideBeforeReview } from "./decide.js";

const card = {
  acceptance: [
    { id: "A1", text: "does a", verify: "unit" as const },
    { id: "A2", text: "does b", verify: "unit" as const },
  ],
};

const outcome = (
  verdict: "approve" | "request-changes" | "needs-human",
  acceptance: {
    id: string;
    status: "met" | "unmet" | "unverified";
    note: string;
  }[],
  blocking = 0,
  unreviewed: string[] = [],
) => ({
  verdict,
  result: {
    blocking: Array.from({ length: blocking }, () => ({
      kind: "defect" as const,
      file: "a.ts",
      line: 1,
      title: "t",
      detail: "",
      repro: "",
      fix: "",
    })),
    acceptance,
    unreviewed,
  },
});

const met = [
  { id: "A1", status: "met" as const, note: "" },
  { id: "A2", status: "met" as const, note: "" },
];

describe("decideBeforeReview", () => {
  it("sends a protected change to a person and asks about it", () => {
    expect(
      decideBeforeReview({
        tier1: { verdict: "needs-human", changedFiles: 2 },
        pendingProtected: 1,
        card,
        round: 1,
      }),
    ).toMatchObject({
      verdict: "needs a human",
      why: "1 protected change(s)",
      asks: ["judge: 1 protected change(s); look at the change"],
    });
  });

  it("sends tier 1 failures and empty changes back, then to a person past the rounds", () => {
    const fail = { tier1: { verdict: "fail" as const, changedFiles: 1 } };
    expect(
      decideBeforeReview({ ...fail, pendingProtected: 0, card, round: 1 }),
    ).toMatchObject({ verdict: "failed", why: "tier 1 failed", asks: [] });
    expect(
      decideBeforeReview({ ...fail, pendingProtected: 0, card, round: 3 })
        ?.verdict,
    ).toBe("needs a human");
    expect(
      decideBeforeReview({
        tier1: { verdict: "pass", changedFiles: 0 },
        pendingProtected: 0,
        card,
        round: 1,
      }),
    ).toMatchObject({
      verdict: "failed",
      why: "the change is empty: no file differs from the base, and the card has 2 acceptance item(s)",
    });
  });

  it("leaves a passing, non-empty change to the review", () => {
    expect(
      decideBeforeReview({
        tier1: { verdict: "pass", changedFiles: 3 },
        pendingProtected: 0,
        card,
        round: 1,
      }),
    ).toBeNull();
  });
});

describe("decideAfterReview", () => {
  const base = {
    card,
    round: 1,
    allowed: new Set<string>(),
    autonomy: async () => "review-at-pr",
  };

  it("passes an approved change with every criterion met", async () => {
    expect(
      await decideAfterReview({ ...base, outcome: outcome("approve", met) }),
    ).toEqual({
      verdict: "passed",
      why: "",
      asks: [],
      unverified: [],
      unmet: [],
    });
  });

  it("fails on blocking findings, and on an unmet criterion whatever the review says", async () => {
    expect(
      await decideAfterReview({
        ...base,
        outcome: outcome("request-changes", met, 2),
      }),
    ).toMatchObject({ verdict: "failed", why: "2 blocking" });
    expect(
      await decideAfterReview({
        ...base,
        outcome: outcome("approve", [
          { id: "A1", status: "unmet", note: "no" },
          { id: "A2", status: "met", note: "" },
        ]),
      }),
    ).toMatchObject({
      verdict: "failed",
      why: "1 acceptance item(s) unmet: A1",
      unmet: ["A1"],
    });
  });

  it("stops for a person on an unverified or unreported criterion, unless one allowed it", async () => {
    const unverified = outcome("needs-human", [
      { id: "A1", status: "met", note: "" },
      { id: "A2", status: "unverified", note: "no proof" },
    ]);
    expect(
      await decideAfterReview({ ...base, outcome: unverified }),
    ).toMatchObject({
      verdict: "needs a human",
      why: "1 acceptance item(s) unverified at autonomy review-at-pr",
      asks: ["unverified_acceptance: A2 (no proof)"],
    });
    expect(
      (
        await decideAfterReview({
          ...base,
          outcome: unverified,
          allowed: new Set(["unverified_acceptance: A2 (no proof)"]),
        })
      ).verdict,
    ).toBe("passed");
    // Silence isn't a verification.
    expect(
      (
        await decideAfterReview({
          ...base,
          outcome: outcome("approve", [{ id: "A1", status: "met", note: "" }]),
        })
      ).unverified,
    ).toEqual([{ id: "A2", note: "the reviewer didn't report on it" }]);
  });

  it("asks about files the reviewer wasn't shown", async () => {
    expect(
      await decideAfterReview({
        ...base,
        outcome: outcome("needs-human", met, 0, [".env.example"]),
      }),
    ).toMatchObject({
      verdict: "needs a human",
      why: "the reviewer wasn't shown .env.example",
      asks: [
        "judge: the reviewer wasn't shown .env.example; look at the change",
      ],
    });
  });

  it("reads the autonomy level only when it names it", async () => {
    let read = 0;
    await decideAfterReview({
      ...base,
      autonomy: async () => {
        read++;
        return "supervised";
      },
      outcome: outcome("approve", met),
    });
    expect(read).toBe(0);
  });
});
