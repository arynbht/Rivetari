import type { CaseRun, EvalResult } from "@arynbht/rivetari-runtime";
import { describe, expect, it } from "vitest";

import { renderEval } from "./judge-eval.js";

const run = (over: Partial<CaseRun>): CaseRun => ({
  id: "case",
  task: "T-0001",
  label: "defect",
  expected: "block",
  caughtBy: "decider",
  pilotVerdict: "passed",
  outcome: "missed",
  verdict: "passed",
  why: "",
  matched: [],
  reasons: [],
  tier1: {
    verdict: "pass",
    changedFiles: 1,
    protected: [],
    notes: [],
    checks: [
      {
        id: "quality.tests.pass",
        outcome: "pass",
        source: "live",
        message: "",
      },
      {
        id: "quality.lint.clean",
        outcome: "pass",
        source: "recorded",
        message: "",
      },
    ],
  },
  risk: null,
  review: null,
  asks: [],
  notes: [],
  durationMs: 1000,
  ...over,
});

describe("renderEval", () => {
  it("shows each case's outcome and the totals", () => {
    const result: EvalResult = {
      at: "2026-11-24T00:00:00Z",
      label: "x",
      commit: "c404a83b16601234",
      tier2: true,
      model: null,
      summary: {
        defects: 2,
        caught: 1,
        blockedOther: 0,
        missed: 1,
        clean: 1,
        passed: 0,
        falseBlocks: 1,
        held: 0,
        notReviewed: 0,
        errors: 0,
        tokens: 1200,
        costUsd: 0.5,
        durationMs: 3000,
      },
      cases: [
        run({ id: "a-missed" }),
        run({
          id: "b-caught",
          outcome: "caught",
          verdict: "failed",
          why: "1 blocking",
          matched: ["band.?edge"],
        }),
        run({
          id: "c-clean",
          label: "clean",
          expected: "pass",
          caughtBy: null,
          outcome: "false-block",
          verdict: "failed",
        }),
      ],
    };
    const text = renderEval(result, false);
    expect(text).toContain(
      "Judge eval · 3 case(s) · tier 1 and tier 2 · c404a83b1660",
    );
    expect(text).toMatch(
      /a-missed\s+MISSED · passed · pilot: caught by decider/,
    );
    expect(text).toMatch(/b-caught\s+caught · failed \(1 blocking\)/);
    expect(text).toContain("matched: band.?edge");
    expect(text).toMatch(/c-clean\s+FALSE BLOCK · failed$/m);
    expect(text).toContain("tier 1 pass: 1 live, 1 recorded, 0 not run");
    expect(text).toContain(
      "Defects: 1/2 caught · 1 missed · 0 blocked for another reason",
    );
    expect(text).toContain(
      "Clean:   0/1 passed · 1 false block(s) · 0 held for a person",
    );
    expect(text).toContain("0 error(s) · 1200 tokens · $0.50 · 3s of judging");
  });
});
