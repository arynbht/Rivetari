import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TaskHistoryRow } from "@arynbht/rivetari-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import { costFlags, renderCost, runMetrics } from "./metrics.js";

const row = (
  task: string,
  cost_usd: number,
  extra: Partial<TaskHistoryRow> = {},
): TaskHistoryRow => ({
  kind: "task",
  date: "2026-11-23",
  task,
  type: "feature",
  outcome: "merged",
  pr: 1,
  sectors: [],
  skills: [],
  minutes: 1,
  tokens: 1,
  cost_usd,
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

  it("lists a low-risk task over $1 with its id, cost and prompt tokens", async () => {
    const text = await metricsWith([
      row("T-0001", 1.4, { risk: "low", prompt_tokens: 48000 }),
      row("T-0002", 0.8, { risk: "low", prompt_tokens: 9000 }),
      row("T-0003", 3, { risk: "medium", prompt_tokens: 70000 }),
    ]);
    expect(text).toContain(
      "Cost\n\nLow-risk tasks over $1:\n  T-0001  $1.40  48000 prompt tokens\n",
    );
    expect(text).not.toContain("T-0002");
    expect(text).not.toContain("T-0003");
    expect(text).not.toContain("none: no low-risk task cost over $1");
  });

  it("says so plainly when no low-risk task cost over $1", async () => {
    const text = await metricsWith([
      row("T-0002", 0.8, { risk: "low" }),
      row("T-0003", 3, { risk: "high" }),
    ]);
    expect(text).toContain(
      "Low-risk tasks over $1:\n  none: no low-risk task cost over $1\n",
    );
  });

  it("never flags a row written before risk was recorded", async () => {
    const text = await metricsWith([row("T-0009", 5)]);
    expect(text).not.toContain("T-0009");
    expect(text).toContain("none: no low-risk task cost over $1");
  });

  it("flags only low-risk rows strictly over $1, and renders a missing prompt size as n/a", () => {
    const rows = [
      row("T-0001", 1.01, { risk: "low" }),
      row("T-0002", 1, { risk: "low" }),
      row("T-0003", 2, { risk: "high" }),
      row("T-0004", 9),
    ];
    expect(costFlags(rows).map((r) => r.task)).toEqual(["T-0001"]);
    expect(renderCost(rows)).toBe(
      "Cost\n\nLow-risk tasks over $1:\n  T-0001  $1.01  n/a prompt tokens",
    );
    expect(renderCost([])).toBe(
      "Cost\n\nLow-risk tasks over $1:\n  none: no low-risk task cost over $1",
    );
  });
});
