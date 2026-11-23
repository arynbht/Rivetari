// Two approved tasks through runTask side by side, as `task run --parallel 2`
// drives them: each gets its own worktree and port, and both ship.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentCall } from "../agent/build.js";
import type { Isolation } from "../agent/isolate.js";
import type { reviewLocal } from "../judge/review.js";
import type { Tier1Options, Tier1Result } from "../judge/tier1.js";
import { approveRoute, routeTask } from "../router/task-route.js";
import { oneAtATime, parallelExitCode, runParallel } from "./parallel.js";
import { runTask } from "./run.js";
import { confirmTask, newTask, TASKS_DIR } from "./tasks.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-23T01:00:00Z") };

const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) {
    await simpleGit(d)
      .raw(["worktree", "prune"])
      .catch(() => undefined);
    await rm(d, { recursive: true, force: true });
  }
  made.length = 0;
});

const FILES = {
  "package.json": `${JSON.stringify({ name: "demo", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/total.js": "exports.total = () => 0;\n",
  "src/max.js": "exports.max = () => 0;\n",
};

async function repoWithTasks(): Promise<{ repo: string; ids: string[] }> {
  const repo = await tmp("rivetari-parallel-run-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  for (const [path, text] of Object.entries(FILES)) {
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
    files: Object.keys(FILES),
    checks: ["quality.tests.pass"],
  };
  const ids: string[] = [];
  for (const [title, file] of [
    ["Fix total so it sums", "src/total.js"],
    ["Fix max so it finds the largest", "src/max.js"],
  ] as const) {
    const draft = await newTask(
      repo,
      {
        title,
        type: "fix",
        description: `${file} returns 0; it should work out its list.`,
        acceptance: [{ id: "A1", text: "it works", verify: "unit" }],
        touches: [file],
      },
      { ...by, id: `T-000${ids.length + 1}` },
    );
    const id = draft.card.id;
    await confirmTask(repo, id, by);
    await routeTask(repo, id, { ...by, context });
    await approveRoute(repo, id, { ...by, context });
    ids.push(id);
  }
  return { repo, ids };
}

/** Builds take a moment, so the two tasks are in flight together. */
const agent = async (call: AgentCall) => {
  if (call.mode === "plan") return JSON.stringify({ steps: ["fix it"] });
  await new Promise((r) => setTimeout(r, 200));
  await writeFile(join(call.cwd, "NOTE.md"), `${call.cwd}\n`);
  return "fixed";
};

const tier1 = async (o: Tier1Options): Promise<Tier1Result> => ({
  verdict: "pass",
  base: o.base,
  head: o.head ?? "",
  mergeBase: (
    await simpleGit(o.repoPath).raw(["merge-base", o.base, o.head ?? "HEAD"])
  ).trim(),
  changedFiles: 1,
  protected: [],
  checks: [
    {
      id: "quality.tests.pass",
      title: "Tests pass",
      base: "green",
      head: "green",
      outcome: "pass",
      message: "",
    },
  ],
  notes: [],
  workDir: "",
  testRun: { command: "npm test", exitCode: 0, output: "ok" },
});

const review: typeof reviewLocal = async (o) => ({
  verdict: "approve",
  round: o.round ?? 1,
  body: "ok",
  result: {
    verdict: "approve",
    blocking: [],
    suggestions: [],
    acceptance: [{ id: "A1", status: "met", note: "" }],
    unreviewed: [],
    model: "judge-model",
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
});

describe("runTask under runParallel", { timeout: 240_000 }, () => {
  it("runs two disjoint tasks at once, each in its own worktree on its own port", async () => {
    const { repo, ids } = await repoWithTasks();
    const isolating = oneAtATime();
    let inFlight = 0;
    let peak = 0;
    let pr = 0;
    const results = await runParallel(
      [
        { id: ids[0] as string, touches: ["src/total.js"] },
        { id: ids[1] as string, touches: ["src/max.js"] },
      ],
      {
        parallel: 2,
        run: async (id) => {
          peak = Math.max(peak, ++inFlight);
          try {
            return await runTask(repo, id, {
              ...by,
              base: "main",
              otherTasks: ids.filter((other) => other !== id),
              isolating,
              agent,
              prove: { deferTestRun: true, publish: async () => null },
              judge: { tier1, review, publish: async () => null },
              ship: {
                push: async () => undefined,
                openPr: async () => ({
                  number: ++pr,
                  url: `https://x/pull/${pr}`,
                  reused: false,
                }),
                postReview: async () => "https://x/pull/1#review",
              },
            });
          } finally {
            inFlight--;
          }
        },
      },
    );
    expect(
      results.map((r) => r.status),
      JSON.stringify(results),
    ).toEqual(["shipped", "shipped"]);
    expect(parallelExitCode(results)).toBe(0);
    expect(peak).toBe(2);
    const envs = await Promise.all(
      ids.map(
        async (id) =>
          JSON.parse(
            await readFile(join(repo, TASKS_DIR, id, "env.json"), "utf8"),
          ) as Isolation,
      ),
    );
    expect(new Set(envs.map((e) => e.port)).size).toBe(2);
    expect(new Set(envs.map((e) => e.worktree)).size).toBe(2);
  });
});
