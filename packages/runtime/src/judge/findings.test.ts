import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { type TaskHistoryRow, taskFindings } from "../ship/close.js";
import { findingsMetrics } from "./findings.js";
import { changeChecks } from "./tier1.js";
import { findingPattern } from "./tier2.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});
const tmp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "factory-findings-"));
  made.push(dir);
  return dir;
};

const row = (
  task: string,
  pr: number | null,
  findings: TaskHistoryRow["findings"],
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

describe("finding patterns", () => {
  it("are stable across file names, numbers and quoted names, and differ by kind", () => {
    const a = findingPattern(
      "suggestion",
      "The sibling `factory.factory.yml` in src/init.ts:505 runs as a live workflow",
    );
    const b = findingPattern(
      "suggestion",
      "The sibling `ci.factory.yml` in packages/cli/src/x.ts:12 runs as a live workflow",
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(
      findingPattern(
        "defect",
        "The sibling `ci.factory.yml` in packages/cli/src/x.ts:12 runs as a live workflow",
      ),
    ).not.toBe(a);
  });

  it("are read from every judge round of a task, once each", async () => {
    const repo = await tmp();
    const dir = join(repo, ".factory", "tasks", "T-0004", "judge");
    await mkdir(dir, { recursive: true });
    const finding = {
      kind: "suggestion",
      title: "Section references disagree",
      file: "a.ts",
      line: 1,
    };
    await writeFile(
      join(dir, "round-1.json"),
      JSON.stringify({ review: { blocking: [], suggestions: [finding] } }),
    );
    await writeFile(
      join(dir, "round-2.json"),
      JSON.stringify({
        review: {
          blocking: [],
          suggestions: [
            finding,
            { ...finding, title: "Another one", pattern: "abc123abc123" },
          ],
        },
      }),
    );
    expect(await taskFindings(repo, "T-0004")).toEqual([
      {
        pattern: findingPattern("suggestion", "Section references disagree"),
        kind: "suggestion",
        title: "Section references disagree",
      },
      { pattern: "abc123abc123", kind: "suggestion", title: "Another one" },
    ]);
  });
});

describe("findings metrics", () => {
  it("counts findings per PR and lists a pattern seen in two PRs as a candidate rule", async () => {
    const repo = await tmp();
    const live = {
      pattern: "aaaaaaaaaaaa",
      kind: "suggestion",
      title: "A generated sibling lands in .github/workflows",
    };
    const once = {
      pattern: "bbbbbbbbbbbb",
      kind: "defect",
      title: "Off by one",
    };
    const metrics = await findingsMetrics(repo, [
      row("T-0001", 10, [live, once]),
      row("T-0002", 11, [live]),
      row("T-0003", null, []),
      row("T-0000", null, undefined),
    ]);
    expect(metrics.reviewed).toBe(3);
    expect(metrics.findings).toBe(3);
    expect(metrics.findingsPerPr).toBeCloseTo(1, 5);
    expect(metrics.candidates).toEqual([{ ...live, prs: ["#10", "#11"] }]);
    expect(metrics.patterns.map((p) => p.pattern)).toEqual([
      "aaaaaaaaaaaa",
      "bbbbbbbbbbbb",
    ]);
  });

  it("counts the judge's tier 1 rules: the catalog's change checks and the diff rules", async () => {
    const metrics = await findingsMetrics(await tmp(), []);
    const catalog = (await changeChecks()).length;
    expect(metrics.tier1Rules).toEqual({
      catalog,
      diff: 3,
      total: catalog + 3,
    });
    expect((await changeChecks()).map((c) => c.id)).toContain(
      "quality.boundaries.clean",
    );
  });

  it("reads task rows from the local history file", async () => {
    const repo = await tmp();
    await mkdir(join(repo, ".factory"), { recursive: true });
    await writeFile(
      join(repo, ".factory", "history.jsonl"),
      [
        JSON.stringify({ date: "2026-11-20", byLane: {} }),
        JSON.stringify(
          row("T-0009", 3, [
            { pattern: "cccccccccccc", kind: "defect", title: "x" },
          ]),
        ),
      ].join("\n"),
    );
    const metrics = await findingsMetrics(repo);
    expect(metrics.reviewed).toBe(1);
    expect(metrics.patterns[0]?.prs).toEqual(["#3"]);
  });
});
