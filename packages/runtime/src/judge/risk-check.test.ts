// The judge derives the risk again from the change; when it's higher than the
// card's, the higher one counts (the fast path goes by it) and the ledger and
// the PR say why.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentCall } from "../agent/build.js";
import { approveRoute, routeTask } from "../router/task-route.js";
import { parseCard } from "../task/card.js";
import { runTask } from "../task/run.js";
import { confirmTask, newTask } from "../task/tasks.js";
import { FAST_REVIEW_MODEL } from "./fast-path.js";
import type { reviewLocal } from "./review.js";
import { changedLines, judgeRisk } from "./risk-check.js";
import type { Tier1Options, Tier1Result } from "./tier1.js";

const made: string[] = [];
const saved = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-20T10:00:00Z") };

const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (saved === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = saved;
  for (const d of made) {
    await simpleGit(d)
      .raw(["worktree", "prune"])
      .catch(() => undefined);
    await rm(d, { recursive: true, force: true });
  }
  made.length = 0;
});

const BASE = {
  "package.json": `${JSON.stringify({ name: "demo", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/total.js": "exports.total = () => 0;\n",
  "src/total.test.js":
    'const t = require("node:test"); const a = require("node:assert"); const { total } = require("./total.js");\nt.test("returns 0", () => a.equal(total([]), 0));\n',
};

async function baseRepo(): Promise<string> {
  const repo = await tmp("rivetari-judge-risk-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  for (const [path, text] of Object.entries(BASE)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  return repo;
}

/** Commit `files` on top of main; returns base and head. */
async function change(repo: string, files: Record<string, string>) {
  const git = simpleGit(repo);
  const base = (await git.revparse(["HEAD"])).trim();
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await git.add(["-A"]);
  await git.commit("change", ["--no-verify"]);
  return { base, head: (await git.revparse(["HEAD"])).trim() };
}

const lowCard = (touches: string[]) =>
  parseCard({
    id: "T-0001",
    title: "Fix total",
    type: "fix",
    description: "d",
    acceptance: [{ id: "A1", text: "sums", verify: "unit" }],
    touches,
    risk: "low",
    owner: "dev@example.com",
    created: "2026-11-20",
  });

describe("judgeRisk", { timeout: 60_000 }, () => {
  it("keeps the card's risk when the change carries no more", async () => {
    const repo = await baseRepo();
    const { base, head } = await change(repo, {
      "src/total.js": "exports.total = (l) => l.length;\n",
    });
    expect(
      await judgeRisk({
        repoPath: repo,
        base,
        head,
        card: lowCard(["src/total.js"]),
        sensitive: [],
      }),
    ).toEqual({ card: "low", effective: "low", reasons: [] });
  });

  it("raises it from the files the change touched, with why", async () => {
    const repo = await baseRepo();
    const { base, head } = await change(repo, {
      "src/total.js": "exports.total = (l) => l.length;\n",
      "db/migrations/001_totals.sql": "create table totals (n int);\n",
    });
    expect(
      await judgeRisk({
        repoPath: repo,
        base,
        head,
        card: lowCard(["src/total.js"]),
        sensitive: [],
      }),
    ).toEqual({
      card: "low",
      effective: "high",
      reasons: ["high: a migration or schema (db/migrations/001_totals.sql)"],
    });
  });

  it("counts an existing test the card doesn't name as medium, and one it names as nothing", async () => {
    const repo = await baseRepo();
    const { base, head } = await change(repo, {
      "src/total.test.js": "// rewritten\n",
    });
    const judged = (touches: string[]) =>
      judgeRisk({
        repoPath: repo,
        base,
        head,
        card: lowCard(touches),
        sensitive: [],
      });
    expect(await judged(["src/total.js"])).toEqual({
      card: "low",
      effective: "medium",
      reasons: [
        "medium: existing tests the card doesn't name (src/total.test.js)",
      ],
    });
    expect(
      (await judged(["src/total.js", "src/total.test.js"])).effective,
    ).toBe("low");
  });

  it("counts the repo's sensitive list and lease code in the changed lines", async () => {
    const repo = await baseRepo();
    const { base, head } = await change(repo, {
      "src/core/run.js": "module.exports = 1;\n",
      "src/total.js":
        "const LEASE_MS = 1000;\nexports.total = () => LEASE_MS;\n",
    });
    const judged = await judgeRisk({
      repoPath: repo,
      base,
      head,
      card: lowCard(["src/total.js"]),
      sensitive: ["src/core/**"],
    });
    expect(judged.effective).toBe("high");
    expect(judged.reasons).toEqual([
      "high: lease, signing or key code (src/total.js)",
      "medium: the repo's sensitive list (src/core/run.js)",
    ]);
  });

  it("reads a diff's added and removed lines per file", () => {
    const diff = [
      "diff --git a/src/a.js b/src/a.js",
      "index 1..2 100644",
      "--- a/src/a.js",
      "+++ b/src/a.js",
      "@@ -1 +1 @@",
      "-old line",
      "+new line",
      "--- not a header: a removed line that starts with dashes",
      "diff --git a/gone.js b/gone.js",
      "deleted file mode 100644",
      "--- a/gone.js",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-takeLease()",
    ].join("\n");
    expect(changedLines(diff)).toEqual(
      new Map([
        [
          "src/a.js",
          [
            "old line",
            "new line",
            "-- not a header: a removed line that starts with dashes",
          ],
        ],
        ["gone.js", ["takeLease()"]],
      ]),
    );
  });
});

const tier1 = async (o: Tier1Options): Promise<Tier1Result> => ({
  verdict: "pass",
  base: o.base,
  head: o.head ?? "",
  mergeBase: (
    await simpleGit(o.repoPath).raw(["merge-base", o.base, o.head ?? "HEAD"])
  ).trim(),
  changedFiles: 1,
  protected: [],
  checks: [],
  notes: [],
  workDir: "",
});

const approving =
  (models: string[]): typeof reviewLocal =>
  async (o) => {
    models.push(o.model ?? "");
    return {
      verdict: "approve",
      round: o.round ?? 1,
      body: "ok",
      result: {
        verdict: "approve",
        blocking: [],
        suggestions: [],
        acceptance: [{ id: "A1", status: "met", note: "" }],
        unreviewed: [],
        model: o.model ?? "",
        calls: 1,
        usage: { tokens: 10, costUsd: 0.01 },
        packed: {
          files: [],
          omitted: [],
          lines: new Map(),
          agents: null,
          constraints: null,
        },
      },
    };
  };

describe("the judge raises the risk", { timeout: 180_000 }, () => {
  it("records the raise in the ledger and the PR, and reviews on the full path", async () => {
    const repo = await baseRepo();
    const { manifests } = await loadManifests(repo);
    const context = {
      manifests,
      available: new Set<string>(),
      flags: {},
      files: Object.keys(BASE),
      checks: ["quality.tests.pass"],
    };
    const draft = await newTask(
      repo,
      {
        title: "Fix total so it sums",
        type: "fix",
        description: "total() returns 0; it should sum its list.",
        acceptance: [{ id: "A1", text: "total sums a list", verify: "unit" }],
        touches: ["src/total.js"],
      },
      by,
    );
    expect(draft.card.risk).toBe("low");
    const id = draft.card.id;
    await confirmTask(repo, id, by);
    await routeTask(repo, id, { ...by, context });
    await approveRoute(repo, id, { ...by, context });

    const modes: AgentCall["mode"][] = [];
    const models: string[] = [];
    const bodies: string[] = [];
    const outcome = await runTask(repo, id, {
      ...by,
      base: "main",
      agent: async (call) => {
        modes.push(call.mode);
        // A fix that also handles a lease: low by its touches, high by its lines.
        await writeFile(
          join(call.cwd, "src/total.js"),
          "const LEASE_MS = 1000;\nexports.total = (l) => l.reduce((a, b) => a + b, 0);\n",
        );
        return "fixed";
      },
      judge: { tier1, review: approving(models) },
      ship: {
        push: async () => undefined,
        openPr: async (p) => {
          bodies.push(p.body);
          return { number: 7, url: "https://x/pull/7", reused: false };
        },
        postReview: async () => "https://x/pull/7#pullrequestreview-1",
      },
    });
    // Built on the fast path (low at intake), reviewed on the full one.
    expect(modes).toEqual(["build"]);
    expect(models).not.toContain(FAST_REVIEW_MODEL);
    expect(outcome.ran.at(-1)).toBe("ship");
    expect(outcome.task.entries.map((e) => e.text)).toContain(
      "risk raised to high from the card's low by the change: high: lease, signing or key code (src/total.js)",
    );
    expect(bodies[0]).toContain(`Task ${id} · fix · risk high`);
    expect(bodies[0]).toContain(
      "Risk raised from low at the judge, by the change: high: lease, signing or key code (src/total.js).",
    );
  });
});
