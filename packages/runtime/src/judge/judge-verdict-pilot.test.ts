// The pilot's judge bugs at the judge beat. R-13: the round's verdict follows
// the card: an empty change fails without a review, an unmet criterion fails
// whatever the review said, and an unverified one stops for a person at
// supervised too. R-3: the review gets tier 1's checks. R-27: a review that
// crashes leaves its reason in the ledger.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  approveRoute,
  type RouteContext,
  routeTask,
} from "../router/task-route.js";
import { runTask, type RunTaskOptions } from "../task/run.js";
import { confirmTask, loadTask, newTask, nextStep } from "../task/tasks.js";
import type { reviewLocal } from "./review.js";
import { findJudgedTree, loadJudgeRecord } from "./task-judge.js";
import type { Tier1Options, Tier1Result } from "./tier1.js";
import type { Tier2Result } from "./tier2.js";

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

/** A confirmed, routed task at the default autonomy (supervised). */
async function approvedTask(): Promise<{ repo: string; id: string }> {
  const repo = await tmp("rivetari-r13-judge-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  const files: Record<string, string> = {
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
  const context: RouteContext = {
    manifests,
    available: new Set(),
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
      acceptance: [
        { id: "A1", text: "total sums a list", verify: "unit" },
        { id: "A2", text: "total of an empty list is 0", verify: "unit" },
      ],
    },
    by,
  );
  const id = draft.card.id;
  await confirmTask(repo, id, by);
  await routeTask(repo, id, { ...by, context });
  await approveRoute(repo, id, { ...by, context });
  return { repo, id };
}

const tier1 =
  (changedFiles: number) =>
  async (o: Tier1Options): Promise<Tier1Result> => ({
    verdict: "pass",
    base: o.base,
    head: o.head ?? "",
    mergeBase: (
      await simpleGit(o.repoPath).raw(["merge-base", o.base, o.head ?? "HEAD"])
    ).trim(),
    changedFiles,
    protected: [],
    checks: [],
    notes: [],
    workDir: "",
  });

const reviewing =
  (
    acceptance: Tier2Result["acceptance"],
    calls: string[] = [],
  ): typeof reviewLocal =>
  async (o) => {
    calls.push(o.model ?? "");
    return {
      verdict: "approve",
      round: o.round ?? 1,
      body: "ok",
      result: {
        verdict: "approve",
        blocking: [],
        suggestions: [],
        acceptance,
        unreviewed: [],
        model: "judge-model",
        calls: 1,
        usage: { tokens: 10, costUsd: 0.01 },
        packed: {
          files: ["src/total.js"],
          omitted: [],
          lines: new Map(),
          agents: null,
          constraints: null,
        },
      },
    };
  };

function options(review: typeof reviewLocal, changedFiles = 1): RunTaskOptions {
  return {
    ...by,
    base: "main",
    agent: async (call) => {
      if (call.mode === "plan") return JSON.stringify({ steps: ["fix total"] });
      await writeFile(
        join(call.cwd, "src/total.js"),
        "exports.total = (l) => l.reduce((a, b) => a + b, 0);\n",
      );
      return "fixed";
    },
    judge: { tier1: tier1(changedFiles), review },
    ship: {
      push: async () => undefined,
      openPr: async () => ({
        number: 7,
        url: "https://x/pull/7",
        reused: false,
      }),
      postReview: async () => "https://x/pull/7#pullrequestreview-1",
    },
  };
}

const texts = async (repo: string, id: string) =>
  (await loadTask(repo, id)).entries.map((e) => e.text);

describe(
  "R-13: the judge's verdict follows the card",
  { timeout: 180_000 },
  () => {
    it("fails an empty change without paying for a review", async () => {
      const { repo, id } = await approvedTask();
      const calls: string[] = [];
      const outcome = await runTask(
        repo,
        id,
        options(
          reviewing(
            [
              { id: "A1", status: "met", note: "" },
              { id: "A2", status: "met", note: "" },
            ],
            calls,
          ),
          0,
        ),
      );
      expect(outcome.ran).not.toContain("ship");
      expect(calls).toEqual([]);
      const record = await loadJudgeRecord(repo, await loadTask(repo, id));
      expect(record?.verdict).toBe("failed");
      const all = await texts(repo, id);
      expect(all).toContain("acceptance A1: unmet — the change is empty");
      expect(
        all.some((t) =>
          /^judge failed · round 1 · .* · the change is empty/.test(t),
        ),
      ).toBe(true);
    });

    it("fails a round whose review approved with a criterion unmet", async () => {
      const { repo, id } = await approvedTask();
      const outcome = await runTask(
        repo,
        id,
        options(
          reviewing([
            { id: "A1", status: "met", note: "" },
            { id: "A2", status: "unmet", note: "total([]) throws" },
          ]),
        ),
      );
      expect(outcome.ran).not.toContain("ship");
      const record = await loadJudgeRecord(repo, await loadTask(repo, id));
      expect(record?.verdict).toBe("failed");
      expect(
        (await texts(repo, id)).some((t) =>
          /^judge failed · round 1 · .* · 1 acceptance item\(s\) unmet: A2/.test(
            t,
          ),
        ),
      ).toBe(true);
    });

    it("R-3: hands the review tier 1's checks from the same round, and records the tree", async () => {
      const { repo, id } = await approvedTask();
      const seen: unknown[] = [];
      const checks = [
        {
          id: "quality.tests.pass",
          title: "Tests pass",
          base: "green" as const,
          head: "green" as const,
          outcome: "pass" as const,
          message: "",
        },
      ];
      const run = options(async (o) => {
        seen.push(o.tier1);
        return reviewing([
          { id: "A1", status: "met", note: "" },
          { id: "A2", status: "met", note: "" },
        ])(o);
      });
      await runTask(repo, id, {
        ...run,
        judge: {
          ...run.judge,
          tier1: async (o) => ({ ...(await tier1(1)(o)), checks }),
        },
      });
      expect(seen[0]).toEqual(checks);
      const record = await loadJudgeRecord(repo, await loadTask(repo, id));
      expect(record?.tree).toBe(
        (await simpleGit(repo).revparse([`${record?.head}^{tree}`])).trim(),
      );
    });

    it("stops for a person on an unverified criterion at supervised, never a pass", async () => {
      const { repo, id } = await approvedTask();
      const outcome = await runTask(
        repo,
        id,
        options(
          reviewing([
            { id: "A1", status: "met", note: "" },
            { id: "A2", status: "unverified", note: "no test calls total([])" },
          ]),
        ),
      );
      expect(outcome.ran.at(-1)).toBe("judge");
      expect(outcome.next).toMatch(/^stop-and-ask/);
      const all = await texts(repo, id);
      expect(all).toContain(
        "asked: unverified_acceptance: A2 (no test calls total([]))",
      );
      expect(
        all.some((t) =>
          /^judge needs a human · round 1 · .* · 1 acceptance item\(s\) unverified at autonomy supervised/.test(
            t,
          ),
        ),
      ).toBe(true);
    });
  },
);

describe(
  "R-28: a task judge's pass carries to a head with its tree",
  { timeout: 180_000 },
  () => {
    it("finds the passed round for a merge commit whose tree is the judged one", async () => {
      const { repo, id } = await approvedTask();
      await runTask(
        repo,
        id,
        options(
          reviewing([
            { id: "A1", status: "met", note: "" },
            { id: "A2", status: "met", note: "" },
          ]),
        ),
      );
      const record = await loadJudgeRecord(repo, await loadTask(repo, id));
      expect(record?.verdict).toBe("passed");
      const judged = record?.head ?? "";
      const tree = record?.tree ?? "";
      const merge = (
        await simpleGit(repo).raw([
          "commit-tree",
          tree,
          "-p",
          judged,
          "-m",
          "Merge the fix branch",
        ])
      ).trim();
      expect(await findJudgedTree(repo, tree, merge)).toMatchObject({
        verdict: "approve",
        from: judged,
        source: `${id}'s judge, round 1`,
      });
      // The judged head itself carries nothing to itself.
      expect(await findJudgedTree(repo, tree, judged)).toBeNull();
    });
  },
);

describe(
  "R-27: a review that crashes says why in the ledger",
  { timeout: 180_000 },
  () => {
    it("records what the call said and leaves the round to judge again", async () => {
      const { repo, id } = await approvedTask();
      const said =
        "claude CLI failed: claude exited with code 1: error_during_execution: API Error: 529 overloaded";
      const crash: typeof reviewLocal = async () => {
        throw new Error(said);
      };
      await expect(runTask(repo, id, options(crash))).rejects.toThrow(/529/);
      const task = await loadTask(repo, id);
      expect(task.entries.map((e) => e.text)).toContain(
        `review round 1 didn't finish: ${said}`,
      );
      expect(nextStep(task)).toBe("judge");
    });
  },
);
