import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/factory-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentCall } from "../agent/build.js";
import { FAST_REVIEW_MODEL, isFastPath } from "../judge/fast-path.js";
import type { reviewLocal } from "../judge/review.js";
import type { Tier1Options, Tier1Result } from "../judge/tier1.js";
import { JUDGE_DEFAULT_MODEL } from "../judge/tier2.js";
import { approveRoute, routeTask } from "../router/task-route.js";
import { parseCard } from "./card.js";
import type { LedgerEntry } from "./ledger.js";
import { runTask } from "./run.js";
import { confirmTask, newTask } from "./tasks.js";

const made: string[] = [];
const savedConfig = process.env.FACTORY_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-23T02:00:00Z") };

const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
beforeEach(async () => {
  process.env.FACTORY_CONFIG_DIR = await tmp("factory-config-");
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.FACTORY_CONFIG_DIR;
  else process.env.FACTORY_CONFIG_DIR = savedConfig;
  for (const d of made) {
    await simpleGit(d)
      .raw(["worktree", "prune"])
      .catch(() => undefined);
    await rm(d, { recursive: true, force: true });
  }
  made.length = 0;
});

const card = (risk: "low" | "medium", touches: string[]) =>
  parseCard({
    id: "T-0001",
    title: "Fix total",
    type: "fix",
    description: "d",
    acceptance: [{ id: "A1", text: "sums", verify: "unit" }],
    touches,
    risk,
    owner: "dev@example.com",
    created: "2026-11-23",
  });

async function approvedTask(risk: "low" | "medium") {
  const repo = await tmp("factory-fast-path-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  const files = {
    "package.json": `${JSON.stringify({ name: "demo", scripts: { test: "node --test" } }, null, 2)}\n`,
    "src/total.js": "exports.total = () => 0;\n",
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  const { manifests } = await loadManifests(repo);
  const context = {
    manifests,
    available: new Set<string>(),
    flags: {},
    files: Object.keys(files),
    checks: ["quality.tests.pass"],
  };
  const draft = await newTask(
    repo,
    {
      title: "Fix total so it sums",
      type: "fix",
      description: "total() returns 0; it should sum its list.",
      acceptance: [{ id: "A1", text: "total sums a list", verify: "unit" }],
      touches: ["src/total.js", "src/total.test.js"],
      risk,
    },
    by,
  );
  const id = draft.card.id;
  await confirmTask(repo, id, by);
  await routeTask(repo, id, { ...by, context });
  await approveRoute(repo, id, { ...by, context });
  return { repo, id };
}

const tier1 = async (o: Tier1Options): Promise<Tier1Result> => ({
  verdict: "pass",
  base: o.base,
  head: o.head ?? "",
  mergeBase: (
    await simpleGit(o.repoPath).raw(["merge-base", o.base, o.head ?? "HEAD"])
  ).trim(),
  changedFiles: 2,
  protected: [],
  checks: [],
  notes: [],
  workDir: "",
});

function review(models: string[], failFast: boolean): typeof reviewLocal {
  return async (o) => {
    models.push(o.model ?? "");
    if (failFast && o.model === FAST_REVIEW_MODEL)
      throw new Error("request timed out after 180000ms");
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
}

async function run(risk: "low" | "medium", failFast = false) {
  const { repo, id } = await approvedTask(risk);
  const modes: AgentCall["mode"][] = [];
  const models: string[] = [];
  const seen: LedgerEntry[] = [];
  await runTask(repo, id, {
    ...by,
    base: "main",
    onEntry: (e) => seen.push(e),
    agent: async (call) => {
      modes.push(call.mode);
      if (call.mode === "plan") return JSON.stringify({ steps: ["fix it"] });
      await writeFile(
        join(call.cwd, "src/total.js"),
        "exports.total = (l) => l.reduce((a, b) => a + b, 0);\n",
      );
      return "fixed";
    },
    judge: { tier1, review: review(models, failFast) },
    ship: {
      push: async () => undefined,
      openPr: async () => ({
        number: 7,
        url: "https://x/pull/7",
        reused: false,
      }),
      postReview: async () => "https://x/pull/7#pullrequestreview-1",
    },
  });
  return { modes, models, seen };
}

describe("the fast path", { timeout: 180_000 }, () => {
  it("takes low-risk cards with one or two source files, not counting generated files or changesets", () => {
    expect(isFastPath(card("low", ["src/a.ts", "src/a.test.ts"]))).toBe(true);
    expect(
      isFastPath(
        card("low", ["src/a.ts", "packages/action/dist/**", ".changeset/*.md"]),
      ),
    ).toBe(true);
    expect(isFastPath(card("low", ["src/a.ts", "src/b.ts", "src/c.ts"]))).toBe(
      false,
    );
    expect(isFastPath(card("medium", ["src/a.ts"]))).toBe(false);
    expect(isFastPath(card("low", []))).toBe(false);
  });

  it("plans a small low-risk card from its criteria without a plan call, and reviews it with the smaller model", async () => {
    const { modes, models, seen } = await run("low");
    expect(modes).toEqual(["build"]);
    expect(seen.map((e) => e.text)).toContainEqual(
      expect.stringMatching(
        /^build started · fast path \(low risk, 2 source file\(s\)\): planned from the card's criteria, no plan call/,
      ),
    );
    expect(seen.map((e) => e.text)).toContain("1. A1: total sums a list");
    expect(models).toEqual([FAST_REVIEW_MODEL]);
  });

  it("escalates to the full review when the fast one doesn't finish", async () => {
    const { models, seen } = await run("low", true);
    expect(models).toEqual([FAST_REVIEW_MODEL, JUDGE_DEFAULT_MODEL]);
    expect(seen.map((e) => e.text)).toContainEqual(
      expect.stringMatching(/escalating to the full review$/),
    );
  });

  it("leaves a medium-risk card on the full path", async () => {
    const { modes, models } = await run("medium");
    expect(modes).toEqual(["plan", "build"]);
    expect(models).toEqual([JUDGE_DEFAULT_MODEL]);
  });
});
