// An acceptance criterion the reviewer couldn't verify: at review-at-pr and
// above the judge stops for a person with the reason; at supervised it's
// recorded for the person reviewing the PR.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answerStops } from "../agent/build.js";
import {
  approveRoute,
  type RouteContext,
  routeTask,
} from "../router/task-route.js";
import { runTask, type RunTaskOptions } from "../task/run.js";
import { confirmTask, loadTask, newTask, nextStep } from "../task/tasks.js";
import type { reviewLocal } from "./review.js";
import { loadJudgeRecord, unverifiedCriteria } from "./task-judge.js";
import type { Tier1Options, Tier1Result } from "./tier1.js";
import type { Tier2Result } from "./tier2.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-20T18:00:00Z") };

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

async function approvedTask(
  autonomy: string | null,
): Promise<{ repo: string; id: string }> {
  const repo = await tmp("rivetari-unverified-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: "demo", scripts: { test: "node --test" } }, null, 2)}\n`,
    "src/total.js": "exports.total = () => 0;\n",
    ...(autonomy
      ? {
          ".rivetari/profile.yml": `version: 1\nname: demo\ntype: library\nautonomy: ${autonomy}\n`,
        }
      : {}),
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

const approving =
  (acceptance: Tier2Result["acceptance"]): typeof reviewLocal =>
  async (o) => ({
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
        files: [],
        omitted: [],
        lines: new Map(),
        agents: null,
        constraints: null,
      },
    },
  });

const UNVERIFIED: Tier2Result["acceptance"] = [
  { id: "A1", status: "met", note: "src/total.test.js sums [1, 2, 3]" },
  {
    id: "A2",
    status: "unverified",
    note: "no test calls total with an empty list",
  },
];

function options(review: typeof reviewLocal): RunTaskOptions {
  return {
    ...by,
    base: "main",
    agent: async (call) => {
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
    },
    judge: { tier1, review },
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

describe("unverified acceptance", { timeout: 180_000 }, () => {
  it("counts a criterion marked unverified, or not reported at all", () => {
    const card = {
      acceptance: [
        { id: "A1", text: "a", verify: "unit" },
        { id: "A2", text: "b", verify: "manual" },
        { id: "A3", text: "c", verify: "unit" },
      ],
    } as Parameters<typeof unverifiedCriteria>[0];
    expect(
      unverifiedCriteria(card, [
        { id: "A1", status: "met", note: "" },
        { id: "A2", status: "unverified", note: "no screenshot shows it" },
      ]),
    ).toEqual([
      { id: "A2", note: "no screenshot shows it" },
      { id: "A3", note: "the reviewer didn't report on it" },
    ]);
  });

  it("stops at review-at-pr with the reason, so run exits 2, and an allow ships it", async () => {
    const { repo, id } = await approvedTask("review-at-pr");
    const first = await runTask(repo, id, options(approving(UNVERIFIED)));
    expect(first.ran).toEqual(["isolate", "build", "prove", "judge"]);
    // The CLI's `task run` exits 2 when the run ends anywhere but ship.
    expect(first.ran.at(-1)).not.toBe("ship");
    expect(first.next).toMatch(/^stop-and-ask/);
    const task = await loadTask(repo, id);
    const texts = task.entries.map((e) => e.text);
    expect(texts).toContain(
      "asked: unverified_acceptance: A2 (no test calls total with an empty list)",
    );
    expect(texts.some((t) => t.startsWith("asked: judge:"))).toBe(false);
    expect(
      texts.some((t) =>
        /^judge needs a human · round 1 · .* · 1 acceptance item\(s\) unverified at autonomy review-at-pr/.test(
          t,
        ),
      ),
    ).toBe(true);
    expect((await loadJudgeRecord(repo, task))?.verdict).toBe("needs a human");

    await answerStops(repo, id, {
      allow: true,
      note: "checked the empty list by hand",
      ...by,
    });
    const allowed = await loadTask(repo, id);
    expect(nextStep(allowed)).toBe("ship");
    expect(allowed.entries.map((e) => e.text)).toContain(
      "answered: allowed — checked the empty list by hand",
    );
    const second = await runTask(repo, id, options(approving(UNVERIFIED)));
    expect(second.ran).toEqual(["ship"]);
  });

  it("sends the change back to build when a person denies it", async () => {
    const { repo, id } = await approvedTask("unattended");
    // A criterion the reviewer says nothing about is as unverified as one it flags.
    const outcome = await runTask(
      repo,
      id,
      options(approving([{ id: "A1", status: "met", note: "" }])),
    );
    expect(outcome.next).toMatch(/^stop-and-ask/);
    expect((await loadTask(repo, id)).entries.map((e) => e.text)).toContain(
      "asked: unverified_acceptance: A2 (the reviewer didn't report on it)",
    );
    await answerStops(repo, id, {
      allow: false,
      note: "add a test for the empty list",
      ...by,
    });
    expect(nextStep(await loadTask(repo, id))).toMatch(
      /^build: .*a person sent the change back/,
    );
  });

  it("records it at supervised and lets the round pass", async () => {
    const { repo, id } = await approvedTask(null);
    const outcome = await runTask(repo, id, options(approving(UNVERIFIED)));
    expect(outcome.ran.at(-1)).toBe("ship");
    const texts = (await loadTask(repo, id)).entries.map((e) => e.text);
    expect(texts).toContain(
      "unverified acceptance, left to the person reviewing the PR (autonomy supervised): A2 (no test calls total with an empty list)",
    );
    expect(texts.some((t) => t.startsWith("asked: "))).toBe(false);
  });

  it("passes at review-at-pr when every criterion is met", async () => {
    const { repo, id } = await approvedTask("review-at-pr");
    const outcome = await runTask(
      repo,
      id,
      options(
        approving([
          { id: "A1", status: "met", note: "" },
          { id: "A2", status: "met", note: "" },
        ]),
      ),
    );
    expect(outcome.ran.at(-1)).toBe("ship");
  });
});
