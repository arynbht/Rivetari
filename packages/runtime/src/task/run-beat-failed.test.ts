// A run that ends on a beat that threw says which beat and why, as a
// BeatError, so `rivetari task run` exits non-zero with a summary line
// instead of reading as shipped.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { reviewLocal } from "../judge/review.js";
import type { Tier1Options, Tier1Result } from "../judge/tier1.js";
import { approveRoute, routeTask } from "../router/task-route.js";
import { BeatError, runTask } from "./run.js";
import {
  confirmTask,
  loadTask,
  newTask,
  nextStep,
  TaskError,
} from "./tasks.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-24T18:00:00Z") };
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

async function approvedTask(): Promise<{ repo: string; id: string }> {
  const repo = await tmp("rivetari-run-fail-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "demo", scripts: { test: "node --test" } })}\n`,
  );
  await writeFile(join(repo, "src/total.js"), "exports.total = () => 0;\n");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  const { manifests } = await loadManifests(repo);
  const context = {
    manifests,
    available: new Set<string>(),
    flags: {},
    files: ["package.json", "src/total.js"],
    checks: ["quality.tests.pass"],
  };
  const draft = await newTask(
    repo,
    {
      title: "Fix total so it sums",
      type: "fix",
      description: "total() returns 0; it should sum its list.",
      acceptance: [{ id: "A1", text: "total sums a list", verify: "unit" }],
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
  changedFiles: 1,
  protected: [],
  checks: [],
  notes: [],
  workDir: "",
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

describe("a run whose beat throws", { timeout: 180_000 }, () => {
  it("fails with the beat and GitHub's reason when ship is refused, and the task still waits on ship", async () => {
    const { repo, id } = await approvedTask();
    const refused = Object.assign(
      new Error("Validation Failed: No commits between main and fix/t-0001"),
      { status: 422 },
    );
    const run = runTask(repo, id, {
      ...by,
      base: "main",
      agent: async (call) => {
        if (call.mode === "plan")
          return JSON.stringify({ steps: ["fix total"] });
        await writeFile(
          join(call.cwd, "src/total.js"),
          "exports.total = (l) => l.reduce((a, b) => a + b, 0);\n",
        );
        return "fixed";
      },
      prove: { deferTestRun: true },
      judge: { tier1, review },
      ship: {
        push: async () => undefined,
        openPr: async () => {
          throw refused;
        },
        postReview: async () => null,
      },
    });
    const err = await run.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BeatError);
    // A TaskError, so every `rivetari task` command reports it and exits 1.
    expect(err).toBeInstanceOf(TaskError);
    expect(err).toMatchObject({
      beat: "ship",
      task: id,
      reason: refused,
      message: `${id} failed at ship: Validation Failed: No commits between main and fix/t-0001`,
    });
    expect(nextStep(await loadTask(repo, id))).toBe("ship");
  });
});
