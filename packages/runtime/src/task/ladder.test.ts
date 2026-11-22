import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { TaskHistoryRow } from "../ship/close.js";
import { autonomyFor } from "./autonomy.js";
import { parseCard } from "./card.js";
import {
  autonomyEntries,
  autonomyLedger,
  enforceFallback,
  ladder,
  ruleCount,
  setAutonomy,
} from "./ladder.js";

const made: string[] = [];
const savedConfig = process.env.FACTORY_CONFIG_DIR;
const NOW = new Date("2026-11-21T12:00:00Z");
const by = "owner@example.com";

beforeEach(async () => {
  const config = await mkdtemp(join(tmpdir(), "factory-config-"));
  made.push(config);
  process.env.FACTORY_CONFIG_DIR = config;
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.FACTORY_CONFIG_DIR;
  else process.env.FACTORY_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repo(autonomy = "supervised"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "factory-ladder-"));
  made.push(dir);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await mkdir(join(dir, ".factory"), { recursive: true });
  await writeFile(
    join(dir, ".factory", "profile.yml"),
    `version: 1\nname: demo\ntype: library\nautonomy: ${autonomy}\n`,
  );
  await writeFile(join(dir, "README.md"), "# demo\n");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  return dir;
}

const row = (
  task: string,
  pr: number,
  blocking: number,
  extra: Partial<TaskHistoryRow> = {},
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
  findings: [
    ...Array.from({ length: blocking }, (_, i) => ({
      pattern: `p${task}${i}`.padEnd(12, "0"),
      kind: "defect",
      title: `defect ${i}`,
    })),
    { pattern: "suggestion00", kind: "suggestion", title: "a nit" },
  ],
  ...extra,
});

const writeHistory = (dir: string, rows: TaskHistoryRow[]) =>
  writeFile(
    join(dir, ".factory", "history.jsonl"),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`,
  );

const card = parseCard({
  id: "T-0001",
  title: "t",
  type: "fix",
  description: "d",
  acceptance: [{ id: "A1", text: "x", verify: "unit" }],
  owner: by,
  created: "2026-11-21",
});

describe("the trust ladder", () => {
  it("counts the tier 1 rules: checks, diff rules, boundary rules and the repo's own lint rules", async () => {
    const dir = await repo();
    await writeFile(
      join(dir, ".dependency-cruiser.mjs"),
      'export default { forbidden: [ { name: "a", from: {}, to: {} }, { name: "b", from: {}, to: {} } ] };\n',
    );
    await writeFile(
      join(dir, "eslint.config.js"),
      'export default [{ rules: { "factory/one": "error", "factory/two": ["error", {}], "no-undef": "error" } }];\n',
    );
    const count = await ruleCount(dir);
    expect(count.boundaries).toBe(2);
    expect(count.lint).toBe(2);
    expect(count.total).toBe(count.checks + count.diff + 4);
  });

  it("refuses to raise a level the numbers don't support, and says why", async () => {
    const dir = await repo();
    await expect(
      setAutonomy(dir, "review-at-pr", { by, now: NOW }),
    ).rejects.toThrow(
      /review-at-pr isn't earned yet: tier 1 rules \d+: needs 20, or double the count at entry; 0 of 10 reviewed PRs needed for findings per PR; 0 of 10 merged PRs needed for first-pass merge rate\. Raise it anyway with --override/,
    );
    expect(
      await readFile(join(dir, ".factory", "profile.yml"), "utf8"),
    ).toContain("autonomy: supervised");
    expect(await autonomyEntries(dir)).toEqual([]);
  });

  it("raises with an override, writing the reason and the rule count in the ledger", async () => {
    const dir = await repo();
    const { state, kind } = await setAutonomy(dir, "review-at-pr", {
      by,
      override: "the factory's own repo runs one level ahead; rule 6",
      now: NOW,
    });
    expect(kind).toBe("override");
    expect(state.configured).toBe("review-at-pr");
    expect(state.effective).toBe("review-at-pr");
    expect(
      await readFile(join(dir, ".factory", "profile.yml"), "utf8"),
    ).toContain("autonomy: review-at-pr");
    const entries = await autonomyEntries(dir);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      level: "review-at-pr",
      kind: "override",
      note: "reason: the factory's own repo runs one level ahead; rule 6",
      by,
    });
    expect(entries[0]?.rules).toBe(state.numbers.rules.total);
    expect((await (await autonomyLedger(dir)).verify()).ok).toBe(true);
  });

  it("logs an override for the level a repo is already at, so the setting has a record", async () => {
    const dir = await repo("review-at-pr");
    const { kind } = await setAutonomy(dir, "review-at-pr", {
      by,
      override: "already running here; this is the record",
      now: NOW,
    });
    expect(kind).toBe("override");
    expect((await autonomyEntries(dir))[0]?.level).toBe("review-at-pr");
    expect(
      (await setAutonomy(dir, "review-at-pr", { by, now: NOW })).kind,
    ).toBeNull();
  });

  it("always lets a person lower the level, and logs it", async () => {
    const dir = await repo("review-at-pr");
    const { kind, state } = await setAutonomy(dir, "supervised", {
      by,
      now: NOW,
    });
    expect(kind).toBe("lowered");
    expect(state.configured).toBe("supervised");
  });

  it("raises without an override once the numbers support it, counting the rules doubled since entry", async () => {
    const dir = await repo();
    const ledger = await autonomyLedger(dir);
    await ledger.append({
      beat: "route",
      section: "decision",
      text: "autonomy supervised · lowered · rules 4",
      by,
      at: new Date("2026-11-01T00:00:00Z"),
    });
    await writeHistory(
      dir,
      Array.from({ length: 10 }, (_, i) => row(`T-${i}`, 100 + i, 0)),
    );
    const before = await ladder(dir, { now: NOW });
    expect(before.numbers.rulesAtEntry).toBe(4);
    expect(before.unmet["review-at-pr"]).toEqual([]);
    const { kind } = await setAutonomy(dir, "review-at-pr", { by, now: NOW });
    expect(kind).toBe("earned");
  });

  it("drops review-at-pr to supervised when blocking findings pass 1 per PR over the first five, and logs it once", async () => {
    const dir = await repo();
    await setAutonomy(dir, "review-at-pr", {
      by,
      override: "rule 6",
      now: NOW,
    });
    await writeHistory(dir, [
      row("T-1", 1, 0),
      row("T-2", 2, 1),
      row("T-3", 3, 1),
      row("T-4", 4, 1),
      row("T-5", 5, 1),
    ]);
    expect((await ladder(dir, { now: NOW })).effective).toBe("review-at-pr");

    await writeHistory(dir, [row("T-1", 1, 3), row("T-2", 2, 3)]);
    const live = await ladder(dir, { now: NOW });
    expect(live.configured).toBe("review-at-pr");
    expect(live.effective).toBe("supervised");
    expect(live.fallback).toBe(
      "6 blocking findings over 2 PR(s) since entering review-at-pr: more than 1 per PR over five",
    );
    expect(await autonomyFor(dir, card)).toBe("supervised");

    await enforceFallback(dir, { by: "factory runtime", now: NOW });
    await enforceFallback(dir, { by: "factory runtime", now: NOW });
    const fell = (await autonomyEntries(dir)).filter(
      (e) => e.kind === "fell back",
    );
    expect(fell).toHaveLength(1);
    expect(fell[0]?.level).toBe("supervised");

    await writeHistory(dir, []);
    expect((await ladder(dir, { now: NOW })).effective).toBe("supervised");
    await setAutonomy(dir, "review-at-pr", {
      by,
      override: "fixed the findings' cause",
      now: new Date("2026-11-22T12:00:00Z"),
    });
    expect(
      (await ladder(dir, { now: new Date("2026-11-22T12:00:00Z") })).effective,
    ).toBe("review-at-pr");
  });

  it("drops a level when a PR merged since entering it is reverted within 7 days", async () => {
    const dir = await repo();
    await setAutonomy(dir, "review-at-pr", {
      by,
      override: "rule 6",
      now: NOW,
    });
    await writeHistory(dir, [row("T-1", 12, 0)]);
    const git = simpleGit(dir);
    await git.commit('Revert "feat: add the thing (#12)"', ["--allow-empty"]);
    const state = await ladder(dir, { now: NOW });
    expect(state.numbers.reverts).toEqual(["#12 (T-1) reverted within 7 days"]);
    expect(state.effective).toBe("supervised");
  });

  it("can't earn unattended yet: smell counts and sampled reads aren't measured", async () => {
    const dir = await repo();
    const state = await ladder(dir, { now: NOW });
    expect(state.unmet.unattended).toEqual([
      "review-at-pr held 0 of 28 days",
      "smell counts aren't measured yet",
      "the sampled-read slop rate isn't measured yet",
    ]);
  });
});

describe("the rule count with banned patterns", () => {
  it("counts each banned pattern once, not ones a lint rule already covers, and not the lint rule that carries them", async () => {
    const dir = await repo();
    await writeFile(
      join(dir, "eslint.config.js"),
      'export default [{ rules: { "factory/one": "error", "factory/no-banned": ["error", {}] } }];\n',
    );
    await writeFile(
      join(dir, ".factory", "banned.json"),
      JSON.stringify({
        version: 1,
        patterns: [
          { id: "a", pattern: String.raw`a\(`, why: "w", source: "s" },
          { id: "b", pattern: String.raw`b\(`, why: "w", source: "s" },
          {
            id: "c",
            pattern: String.raw`c\(`,
            why: "w",
            source: "finding",
            covered_by: "factory/one",
          },
        ],
      }),
    );
    const count = await ruleCount(dir);
    expect(count.lint).toBe(1);
    expect(count.banned).toBe(2);
    expect(count.total).toBe(count.checks + count.diff + 1 + 2);
  });
});
