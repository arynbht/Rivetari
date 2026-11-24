import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTask, TASKS_BRANCH } from "@arynbht/rivetari-runtime";
import type { RecordedAudit } from "@arynbht/rivetari-engine";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type DraftDeps, draftPostureTask, postureCard } from "./posture-task";

// Posture never writes waivers, evidence or fixes itself: each one drafts a
// card through the runtime, as `rivetari task new` does, checked against the
// recorded audit, and left at intake for a person to confirm.

const BY = "dev@example.com";

const RECORDED: RecordedAudit = {
  generatedAt: "2026-11-23T09:00:00.000Z",
  summary: {
    pass: 1,
    fail: 2,
    needsEvidence: 1,
    waived: 0,
    skip: 0,
    na: 0,
    total: 4,
  },
  controls: [
    {
      id: "ci.workflow.present",
      status: "pass",
      lane: "cicd",
      phase: "scaffold",
      severity: "high",
    },
    {
      id: "ci.changelog-automated",
      status: "fail",
      lane: "cicd",
      phase: "build",
      severity: "low",
    },
    {
      id: "ci.actions-pinned-sha",
      status: "fail",
      lane: "cicd",
      phase: "harden",
      severity: "medium",
    },
    {
      id: "a11y.keyboard.manual-pass",
      status: "needs-evidence",
      lane: "accessibility",
      phase: "build",
      severity: "high",
    },
  ],
};

const ctx = {
  recorded: new Map(RECORDED.controls.map((c) => [c.id, c])),
  titles: new Map([["ci.changelog-automated", "Changelog is automated"]]),
  generatedAt: RECORDED.generatedAt,
  by: BY,
};

describe("postureCard", () => {
  it("drafts one acceptance criterion per gap, each checked by the audit", () => {
    const card = postureCard(
      {
        kind: "gaps",
        controls: ["ci.changelog-automated", "a11y.keyboard.manual-pass"],
      },
      ctx,
    );
    expect(card.title).toBe(
      "Close posture gaps: ci.changelog-automated, a11y.keyboard.manual-pass",
    );
    expect(card.type).toBe("fix");
    expect(card.acceptance).toEqual([
      {
        id: "A1",
        text: "ci.changelog-automated passes in `rivetari audit`",
        verify: "review",
      },
      {
        id: "A2",
        text: "a11y.keyboard.manual-pass passes in `rivetari audit`",
        verify: "review",
      },
    ]);
    expect(card.description).toContain(
      "- ci.changelog-automated: Changelog is automated (fail)",
    );
    expect(card.description).toContain(
      "- a11y.keyboard.manual-pass: a11y.keyboard.manual-pass (needs evidence)",
    );
  });

  it("names one gap in the title, and counts the rest past three", () => {
    expect(
      postureCard({ kind: "gaps", controls: ["ci.changelog-automated"] }, ctx)
        .title,
    ).toBe("Make ci.changelog-automated pass");
    const many = {
      ...ctx,
      recorded: new Map(
        ["a.b", "c.d", "e.f", "g.h", "i.j"].map((id) => [
          id,
          {
            id,
            status: "fail" as const,
            lane: "x",
            phase: "build",
            severity: "low",
          },
        ]),
      ),
    };
    expect(
      postureCard(
        { kind: "gaps", controls: ["a.b", "c.d", "e.f", "g.h", "i.j"] },
        many,
      ).title,
    ).toBe("Close posture gaps: a.b, c.d, e.f and 2 more");
  });

  it("drafts a waiver as a change to the protected waivers.yml, with the reason given", () => {
    const card = postureCard(
      {
        kind: "waive",
        control: "ci.actions-pinned-sha",
        reason: "Renovate pins them next sprint",
        expires: "2027-01-31",
      },
      ctx,
    );
    expect(card.title).toBe("Waive ci.actions-pinned-sha");
    expect(card.description).toContain(
      "Reason: Renovate pins them next sprint",
    );
    expect(card.touches).toEqual([".rivetari/waivers.yml"]);
    expect(card.constraints?.[0]).toMatch(/protected path/);
    expect(card.acceptance.map((a) => a.text)).toEqual([
      ".rivetari/waivers.yml waives ci.actions-pinned-sha until 2027-01-31 with the reason given, an owner and the date it was added",
      "ci.actions-pinned-sha shows as waived in `rivetari audit`",
    ]);
  });

  it("drafts evidence with its link", () => {
    const card = postureCard(
      {
        kind: "evidence",
        control: "a11y.keyboard.manual-pass",
        reason: "Keyboard pass on the settings flow",
        url: "https://example.com/report",
      },
      ctx,
    );
    expect(card.touches).toEqual([".rivetari/evidence.yml"]);
    expect(card.description).toContain("Link: https://example.com/report");
    expect(card.acceptance[0]?.text).toContain(
      "linking https://example.com/report",
    );
  });

  it("refuses a control the recorded audit doesn't have, or one that passes", () => {
    expect(() =>
      postureCard({ kind: "gaps", controls: ["made.up"] }, ctx),
    ).toThrow(/made\.up isn't in the recorded audit/);
    expect(() =>
      postureCard({ kind: "gaps", controls: ["ci.workflow.present"] }, ctx),
    ).toThrow(/is pass in the recorded audit, so there's nothing to fix/);
    expect(() =>
      postureCard(
        {
          kind: "waive",
          control: "ci.workflow.present",
          reason: "x",
          expires: "2027-01-01",
        },
        ctx,
      ),
    ).toThrow(/nothing to waive/);
  });
});

describe("draftPostureTask", () => {
  function fakes(overrides: Partial<DraftDeps> = {}): DraftDeps {
    return {
      whoami: vi.fn(async () => BY),
      readRecordedAudit: vi.fn(async () => RECORDED),
      bundledControls: vi.fn(async () => []),
      reserveTaskId: vi.fn(async () => "T-0009"),
      newTask: vi.fn(
        async (_repo, input) =>
          ({ card: { title: input.title } }) as Awaited<
            ReturnType<DraftDeps["newTask"]>
          >,
      ),
      commitTask: vi.fn(async () => undefined),
      ...overrides,
    };
  }

  it("reserves an id, drafts the card and pushes it, as `task new` does", async () => {
    const deps = fakes();
    const result = await draftPostureTask(
      "/repo",
      { kind: "gaps", controls: ["ci.changelog-automated"] },
      deps,
    );
    expect(result).toEqual({
      id: "T-0009",
      title: "Make ci.changelog-automated pass",
      by: BY,
      warning: null,
    });
    expect(vi.mocked(deps.reserveTaskId).mock.calls[0]?.[1].holder).toMatch(
      /dev@example\.com/,
    );
    expect(vi.mocked(deps.newTask).mock.calls[0]?.[2]).toEqual({
      by: BY,
      id: "T-0009",
    });
    expect(vi.mocked(deps.commitTask).mock.calls[0]?.[2].message).toBe(
      "T-0009: drafted",
    );
  });

  it("refuses before reserving an id when nothing is recorded or the control passes", async () => {
    const none = fakes({ readRecordedAudit: vi.fn(async () => null) });
    await expect(
      draftPostureTask(
        "/repo",
        { kind: "gaps", controls: ["ci.changelog-automated"] },
        none,
      ),
    ).rejects.toThrow(/no audit is recorded/);
    expect(none.reserveTaskId).not.toHaveBeenCalled();

    const passing = fakes();
    await expect(
      draftPostureTask(
        "/repo",
        { kind: "gaps", controls: ["ci.workflow.present"] },
        passing,
      ),
    ).rejects.toThrow(/nothing to fix/);
    expect(passing.reserveTaskId).not.toHaveBeenCalled();
  });

  it("keeps a drafted card when only the push fails, and says so", async () => {
    const deps = fakes({
      commitTask: vi.fn(async () => {
        throw new Error("origin is unreachable");
      }),
    });
    const result = await draftPostureTask(
      "/repo",
      { kind: "gaps", controls: ["ci.changelog-automated"] },
      deps,
    );
    expect(result.warning).toMatch(
      /pushing it failed: origin is unreachable.*T-0009/,
    );
  });

  describe("against a real repo", () => {
    let repo = "";
    const savedKey = process.env.RIVETARI_LEDGER_KEY;
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

    beforeEach(async () => {
      repo = await mkdtemp(join(tmpdir(), "rivetari-desktop-posture-task-"));
      process.env.RIVETARI_LEDGER_KEY = "cd".repeat(32);
      git("init", "-q", "-b", "main");
      git("config", "user.email", BY);
      git("config", "user.name", "Dev");
      git("commit", "-q", "--allow-empty", "-m", "init");
      await mkdir(join(repo, ".rivetari"), { recursive: true });
      await writeFile(
        join(repo, ".rivetari", "state.json"),
        JSON.stringify({ version: 1, ...RECORDED }),
      );
    });

    afterEach(async () => {
      if (savedKey === undefined) delete process.env.RIVETARI_LEDGER_KEY;
      else process.env.RIVETARI_LEDGER_KEY = savedKey;
      await rm(repo, { recursive: true, force: true });
    });

    it("records the card at intake, in the ledger and on the tasks branch", async () => {
      const result = await draftPostureTask(repo, {
        kind: "gaps",
        controls: ["ci.changelog-automated", "ci.actions-pinned-sha"],
      });
      expect(result).toMatchObject({ id: "T-0001", by: BY, warning: null });

      const task = await loadTask(repo, "T-0001", { readOnly: true });
      expect(task.confirmed).toBe(false);
      expect(task.beat).toBe("intake");
      expect(task.card.acceptance.map((a) => a.text)).toEqual([
        "ci.changelog-automated passes in `rivetari audit`",
        "ci.actions-pinned-sha passes in `rivetari audit`",
      ]);
      expect(task.problems).toEqual([]);
      expect(git("show", `${TASKS_BRANCH}:T-0001/card.yml`)).toContain(
        "ci.actions-pinned-sha passes in `rivetari audit`",
      );
      // state.json is read, never rewritten.
      expect(
        JSON.parse(
          await readFile(join(repo, ".rivetari", "state.json"), "utf8"),
        ).generatedAt,
      ).toBe(RECORDED.generatedAt);
    });
  });
});
