// Findings per PR counts blocking findings only, the way the trust ladder's
// blocking-per-PR does; suggestions are counted on their own.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { TaskFinding, TaskHistoryRow } from "../ship/close.js";
import { findingsMetrics } from "./findings.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const row = (
  task: string,
  pr: number,
  findings: TaskFinding[],
): TaskHistoryRow => ({
  kind: "task",
  date: "2026-11-21",
  task,
  type: "fix",
  outcome: "merged",
  pr,
  sectors: [],
  skills: [],
  minutes: 1,
  tokens: 1,
  cost_usd: 0,
  build_rounds: 1,
  judge_rounds: 1,
  findings,
});

const suggestion = (n: number): TaskFinding => ({
  pattern: `s${String(n).padStart(11, "0")}`,
  kind: "suggestion",
  title: `suggestion ${n}`,
});

describe("findings per PR", () => {
  it("counts blocking findings only, and the suggestions on their own", async () => {
    const repo = await mkdtemp(join(tmpdir(), "rivetari-findings-"));
    made.push(repo);
    const metrics = await findingsMetrics(repo, [
      row("T-0001", 1, [
        { pattern: "dddddddddddd", kind: "defect", title: "Off by one" },
        suggestion(1),
        suggestion(2),
      ]),
      row("T-0002", 2, [suggestion(3), suggestion(4)]),
      row("T-0003", 3, [
        { pattern: "cccccccccccc", kind: "contract", title: "Edits a test" },
      ]),
      row("T-0004", 4, []),
    ]);
    expect(metrics).toMatchObject({
      reviewed: 4,
      findings: 6,
      blocking: 2,
      suggestions: 4,
    });
    expect(metrics.findingsPerPr).toBeCloseTo(0.5, 5);
  });

  it("is 0 when every finding was a suggestion, and n/a with nothing reviewed", async () => {
    const repo = await mkdtemp(join(tmpdir(), "rivetari-findings-"));
    made.push(repo);
    const only = await findingsMetrics(repo, [
      row("T-0001", 1, [suggestion(1), suggestion(2)]),
    ]);
    expect(only.findingsPerPr).toBe(0);
    expect(only.suggestions).toBe(2);
    const none = await findingsMetrics(repo, []);
    expect(none.findingsPerPr).toBeNull();
    expect(none).toMatchObject({ blocking: 0, suggestions: 0 });
  });
});
