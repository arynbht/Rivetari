// A claude call that hangs, or a run that outlasts its budget, stops the task
// as a stop-and-ask (so `rivetari task run` exits 2) with the limit that fired
// in the ledger, instead of running all night.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CALL_TIMEOUT_ENV,
  CallTimeoutError,
  spawnWithLimit,
} from "@arynbht/rivetari-engine";
import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { answerStops } from "../agent/build.js";
import type { Tier1Options, Tier1Result } from "../judge/tier1.js";
import { approveRoute, routeTask } from "../router/task-route.js";
import {
  DEFAULT_TASK_BUDGET_MINUTES,
  runTask,
  TASK_BUDGET_ENV,
  taskBudgetMinutes,
} from "./run.js";
import { confirmTask, newTask, nextStep } from "./tasks.js";

const made: string[] = [];
const saved = {
  config: process.env.RIVETARI_CONFIG_DIR,
  call: process.env[CALL_TIMEOUT_ENV],
  budget: process.env[TASK_BUDGET_ENV],
};
const by = { by: "dev@example.com", now: new Date("2026-11-10T18:00:00Z") };

const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
  delete process.env[CALL_TIMEOUT_ENV];
  delete process.env[TASK_BUDGET_ENV];
});
afterEach(async () => {
  restore("RIVETARI_CONFIG_DIR", saved.config);
  restore(CALL_TIMEOUT_ENV, saved.call);
  restore(TASK_BUDGET_ENV, saved.budget);
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
};

async function approvedTask(): Promise<{ repo: string; id: string }> {
  const repo = await tmp("rivetari-timeout-");
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
    },
    by,
  );
  const id = draft.card.id;
  await confirmTask(repo, id, by);
  await routeTask(repo, id, { ...by, context });
  await approveRoute(repo, id, { ...by, context });
  return { repo, id };
}

/** A call that never answers, the way `claude -p` hung overnight. */
const hang = () =>
  spawnWithLimit(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    input: "",
  });

const fix = async (cwd: string) => {
  await writeFile(
    join(cwd, "src/total.js"),
    "exports.total = (l) => l.reduce((a, b) => a + b, 0);\n",
  );
  await writeFile(
    join(cwd, "src/total.test.js"),
    `const t = require("node:test"); const a = require("node:assert"); const { total } = require("./total.js");\nt.test("sums", () => a.equal(total([1, 2, 3]), 6));\n`,
  );
};

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

describe("run time limits", { timeout: 180_000 }, () => {
  it("defaults the run budget to 90 minutes, and RIVETARI_TASK_BUDGET_MINUTES overrides it", () => {
    expect(DEFAULT_TASK_BUDGET_MINUTES).toBe(90);
    expect(taskBudgetMinutes({})).toBe(90);
    expect(taskBudgetMinutes({ [TASK_BUDGET_ENV]: "30" })).toBe(30);
    expect(taskBudgetMinutes({ [TASK_BUDGET_ENV]: "never" })).toBe(90);
  });

  it("kills a build call past its timeout and stops the task with the limit in the ledger", async () => {
    process.env[CALL_TIMEOUT_ENV] = "0.01";
    const { repo, id } = await approvedTask();
    const outcome = await runTask(repo, id, {
      ...by,
      base: "main",
      agent: async (call) =>
        call.mode === "plan"
          ? JSON.stringify({ steps: ["fix total"] })
          : hang(),
    });
    // Not shipped and waiting on a person: `rivetari task run` exits 2.
    expect(outcome.ran).toEqual(["isolate", "build"]);
    expect(outcome.next).toMatch(/^stop-and-ask/);
    const texts = outcome.task.entries.map((e) => e.text);
    expect(texts).toContain(
      "asked: timeout: a claude call ran past its 0.01-minute limit (RIVETARI_CALL_TIMEOUT_MINUTES) and was killed",
    );
    expect(texts).toContain(
      "build stopped: the call timeout of 0.01 min (RIVETARI_CALL_TIMEOUT_MINUTES) ran out",
    );
    // Answered, the build runs again rather than going on to the proof.
    const answered = await answerStops(repo, id, { allow: true, ...by });
    expect(nextStep(answered)).toBe(`build: \`rivetari task build ${id}\``);
  });

  it("the run's budget kills the call in flight", async () => {
    process.env[TASK_BUDGET_ENV] = "0.1";
    const { repo, id } = await approvedTask();
    const outcome = await runTask(repo, id, {
      ...by,
      base: "main",
      agent: async (call) =>
        call.mode === "plan"
          ? JSON.stringify({ steps: ["fix total"] })
          : hang(),
    });
    expect(outcome.next).toMatch(/^stop-and-ask/);
    const texts = outcome.task.entries.map((e) => e.text);
    expect(texts).toContain(
      "asked: timeout: the 0.1-minute budget (RIVETARI_TASK_BUDGET_MINUTES) ran out during a claude call, which was killed",
    );
    expect(texts).toContain(
      "build stopped: the task budget of 0.1 min (RIVETARI_TASK_BUDGET_MINUTES) ran out",
    );
  });

  it("a timed-out review stops the judge as a stop-and-ask, and answering it judges again", async () => {
    const { repo, id } = await approvedTask();
    let reviews = 0;
    const outcome = await runTask(repo, id, {
      ...by,
      base: "main",
      agent: async (call) => {
        if (call.mode === "plan")
          return JSON.stringify({ steps: ["fix total"] });
        await fix(call.cwd);
        return "fixed";
      },
      judge: {
        tier1,
        review: async () => {
          reviews++;
          throw new CallTimeoutError("call", 20, CALL_TIMEOUT_ENV);
        },
      },
    });
    expect(reviews).toBe(1);
    expect(outcome.ran).toEqual(["isolate", "build", "prove", "judge"]);
    expect(outcome.next).toMatch(/^stop-and-ask/);
    const stop = outcome.task.entries.find((e) =>
      e.text.startsWith("asked: timeout:"),
    );
    expect(stop?.beat).toBe("judge");
    expect(outcome.task.entries.map((e) => e.text)).toContain(
      "judge stopped: the call timeout of 20 min (RIVETARI_CALL_TIMEOUT_MINUTES) ran out",
    );
    // No verdict was reached, so allowing it can't ship the change unreviewed.
    const answered = await answerStops(repo, id, { allow: true, ...by });
    expect(nextStep(answered)).toBe("judge");
  });
});
