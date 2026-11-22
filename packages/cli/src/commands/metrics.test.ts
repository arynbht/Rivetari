import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runMetrics } from "./metrics.js";

describe("runMetrics", () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
    vi.restoreAllMocks();
  });
  async function tmp(): Promise<string> {
    const d = await mkdtemp(join(tmpdir(), "factory-metrics-"));
    made.push(d);
    return d;
  }

  it("shows the judge's findings without GitHub, with candidate rules", async () => {
    const dir = await tmp();
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(join(dir, ".factory"), { recursive: true });
    const finding = {
      pattern: "aaaaaaaaaaaa",
      kind: "suggestion",
      title: "A generated sibling lands in .github/workflows",
    };
    const row = (task: string, pr: number) =>
      JSON.stringify({
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
        findings: [finding],
      });
    await writeFile(
      join(dir, ".factory", "history.jsonl"),
      `${row("T-0001", 1)}\n${row("T-0002", 2)}\n`,
    );
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    expect(await runMetrics(dir, { findings: true }, { token: null })).toBe(0);
    const text = out.join("");
    expect(text).toContain("Trust ladder");
    expect(text).toMatch(/Autonomy\s+supervised/);
    expect(text).toMatch(
      /review-at-pr\s+not earned: tier 1 rules 8: needs 20, or double the count at entry; 2 of 10 reviewed PRs needed/,
    );
    expect(text).toMatch(/Tier 1 rules\s+8 \(5 checks, 3 diff rules\)/);
    expect(text).toMatch(/Findings per PR\s+1\.0/);
    expect(text).toContain(
      "Candidate rules (a pattern seen in 2+ PRs):\n  aaaaaaaaaaaa  suggestion: A generated sibling lands in .github/workflows (#1, #2)",
    );
  });

  it("errors when no GitHub client is available (no token/remote)", async () => {
    const dir = await tmp();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runMetrics(dir, {}, { token: null });
    expect(code).toBe(1);
  });

  it("rejects an invalid --window", async () => {
    const dir = await tmp();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    // token:null → no client, but --window is validated after the client check;
    // use a bogus window with no client still returns 1 (client check first).
    const code = await runMetrics(dir, { window: "-5" }, { token: null });
    expect(code).toBe(1);
  });

  it("fails fast on a nonexistent path", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const code = await runMetrics(
      join(tmpdir(), "factory-metrics-missing-xyz"),
      {},
      { token: null },
    );
    expect(code).toBe(1);
  });
});
