import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TaskHistoryRow } from "@arynbht/rivetari-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { costFlags, renderCost, runMetrics } from "./metrics.js";

const row = (
  task: string,
  cost: number,
  extra: Partial<TaskHistoryRow> = {},
): TaskHistoryRow => ({
  kind: "task",
  date: "2026-11-22",
  task,
  type: "feature",
  outcome: "merged",
  pr: Number(task.slice(2)),
  sectors: [],
  skills: [],
  minutes: 1,
  tokens: 1,
  cost_usd: cost,
  build_rounds: 1,
  judge_rounds: 1,
  ...extra,
});

describe("metrics cost section", () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
    vi.restoreAllMocks();
  });

  async function metricsWith(rows: TaskHistoryRow[]): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "rivetari-metrics-cost-"));
    made.push(dir);
    await mkdir(join(dir, ".rivetari"), { recursive: true });
    await writeFile(
      join(dir, ".rivetari", "history.jsonl"),
      rows.map((r) => `${JSON.stringify(r)}\n`).join(""),
    );
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    expect(await runMetrics(dir, { findings: true }, { token: null })).toBe(0);
    return out.join("");
  }

  it("lists each low-risk task over $1 with its cost and prompt tokens, and nothing else", async () => {
    const text = await metricsWith([
      row("T-0001", 1.5, { risk: "low", prompt_tokens: 18_400 }),
      row("T-0002", 0.8, { risk: "low", prompt_tokens: 9000 }),
      row("T-0003", 3, { risk: "medium", prompt_tokens: 40_000 }),
      row("T-0004", 5),
    ]);
    const cost = text.slice(text.indexOf("Cost (low-risk tasks over $1)"));
    expect(cost).toBe(
      "Cost (low-risk tasks over $1)\n\n  T-0001  $1.50  prompt tokens 18400\n",
    );
    for (const id of ["T-0002", "T-0003", "T-0004"])
      expect(cost).not.toContain(id);
  });

  it("says so plainly when no low-risk task cost over $1", async () => {
    const text = await metricsWith([
      row("T-0001", 1, { risk: "low" }),
      row("T-0002", 9),
    ]);
    expect(text).toContain(
      "Cost (low-risk tasks over $1)\n\n  no low-risk task cost over $1\n",
    );
  });

  it("never flags a row written before risk was recorded", () => {
    expect(costFlags([row("T-0004", 12)])).toEqual([]);
    expect(renderCost([row("T-0004", 12)])).toContain(
      "no low-risk task cost over $1",
    );
  });

  it("prints n/a for a flagged task with no prompt size", () => {
    const flagged = row("T-0005", 2.5, { risk: "low" });
    expect(costFlags([flagged])).toEqual([flagged]);
    expect(renderCost([flagged])).toContain(
      "  T-0005  $2.50  prompt tokens n/a",
    );
  });
});
