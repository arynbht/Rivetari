// A test-run proof deferred to the judge: the suite runs once a round, in the
// judge's tier 1 run on the change, and that run is the proof and its evidence.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/factory-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentCall } from "../agent/build.js";
import type { reviewLocal } from "../judge/review.js";
import type { Tier1Options, Tier1Result } from "../judge/tier1.js";
import { DEFERRED } from "../proof/prove.js";
import { approveRoute, routeTask } from "../router/task-route.js";
import type { LedgerEntry } from "./ledger.js";
import { runTask } from "./run.js";
import { confirmTask, newTask } from "./tasks.js";

const made: string[] = [];
const savedConfig = process.env.FACTORY_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-23T01:00:00Z") };

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

async function approvedTask(): Promise<{ repo: string; id: string }> {
  const repo = await tmp("factory-run-deferred-");
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
    },
    by,
  );
  const id = draft.card.id;
  await confirmTask(repo, id, by);
  await routeTask(repo, id, { ...by, context });
  await approveRoute(repo, id, { ...by, context });
  return { repo, id };
}

const agent = async (call: AgentCall) => {
  if (call.mode === "plan") return JSON.stringify({ steps: ["fix total"] });
  await writeFile(
    join(call.cwd, "src/total.js"),
    "exports.total = (l) => l.reduce((a, b) => a + b, 0);\n",
  );
  await writeFile(
    join(call.cwd, "src/total.test.js"),
    'const t = require("node:test"); const a = require("node:assert"); const { total } = require("./total.js");\nt.test("sums", () => a.equal(total([1, 2, 3]), 6));\n',
  );
  return "fixed";
};

function tier1(outcome: "pass" | "fail", calls: Tier1Options[]) {
  return async (o: Tier1Options): Promise<Tier1Result> => {
    calls.push(o);
    return {
      verdict: outcome,
      base: o.base,
      head: o.head ?? "",
      mergeBase: (
        await simpleGit(o.repoPath).raw([
          "merge-base",
          o.base,
          o.head ?? "HEAD",
        ])
      ).trim(),
      changedFiles: 2,
      protected: [],
      checks: [
        {
          id: "quality.tests.pass",
          title: "Tests pass",
          base: "green",
          head: outcome === "pass" ? "green" : "red",
          outcome,
          message: outcome === "pass" ? "" : "1 test failed: sums",
        },
      ],
      notes: [],
      workDir: "",
      testRun: {
        command: "npm test",
        exitCode: outcome === "pass" ? 0 : 1,
        output: `the judge's own test output (${outcome})`,
      },
    };
  };
}

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

describe("a deferred test-run proof", { timeout: 180_000 }, () => {
  it("runs no suite of its own: the judge's tier 1 run is the proof, its log the evidence", async () => {
    const { repo, id } = await approvedTask();
    const seen: LedgerEntry[] = [];
    const calls: Tier1Options[] = [];
    const published: string[][] = [];
    const publish = async (files: readonly string[]) => {
      published.push([...files]);
      return null;
    };
    const outcome = await runTask(repo, id, {
      ...by,
      base: "main",
      onEntry: (e) => seen.push(e),
      agent,
      prove: { deferTestRun: true, publish },
      judge: { tier1: tier1("pass", calls), review, publish },
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
    expect(outcome.ran).toEqual(["isolate", "build", "prove", "judge", "ship"]);
    expect(calls).toHaveLength(1);
    const timeline = seen
      .filter((e) => e.section === "timeline")
      .map((e) => e.text);
    expect(timeline).toContain(DEFERRED);
    expect(timeline).toContain(
      "proof passed · test-run (the judge's tier 1 run)",
    );
    expect(
      seen.some(
        (e) =>
          e.section === "proof" &&
          e.text.startsWith(
            "tests passed (npm test, exit 0, in the judge's tier 1 run on the change) · new tests: src/total.test.js: sums",
          ),
      ),
    ).toBe(true);
    const proof = JSON.parse(
      await readFile(
        join(repo, ".factory", "tasks", id, "proof", "proof.json"),
        "utf8",
      ),
    ) as { passed: boolean; tests: { output: string } };
    expect(proof.passed).toBe(true);
    expect(proof.tests.output).toBe("the judge's own test output (pass)");
    expect(published).toHaveLength(1);
    expect(published[0]?.[0]).toMatch(/test-run\.txt$/);
  });

  it("fails with the judge's run when the suite fails, and goes back to build", async () => {
    const { repo, id } = await approvedTask();
    const seen: LedgerEntry[] = [];
    let builds = 0;
    const outcome = await runTask(repo, id, {
      ...by,
      base: "main",
      onEntry: (e) => seen.push(e),
      agent: async (call) => {
        if (call.mode === "build") builds++;
        return agent(call);
      },
      prove: { deferTestRun: true, publish: async () => null },
      judge: {
        tier1: tier1("fail", []),
        review,
        publish: async () => null,
      },
    });
    expect(builds).toBeGreaterThan(1);
    expect(seen.map((e) => e.text)).toContain(
      "proof failed · test-run (the judge's tier 1 run)",
    );
    expect(outcome.next).not.toMatch(/^close/);
  });
});
