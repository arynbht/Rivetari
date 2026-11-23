// The `rivetari/judge` check run on ship: posted on the judged head, with the
// record's sha256 and the ledger hash, only when CI may trust the judge.
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { JudgeCheckParams } from "@arynbht/rivetari-engine";
import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildTask } from "../agent/build.js";
import { isolateTask } from "../agent/isolate.js";
import { roundVerdict, type reviewLocal } from "../judge/review.js";
import { judgeTask } from "../judge/task-judge.js";
import type { Tier1Options, Tier1Result } from "../judge/tier1.js";
import type { Tier2Result } from "../judge/tier2.js";
import { proveTask } from "../proof/prove.js";
import {
  approveRoute,
  type RouteContext,
  routeTask,
} from "../router/task-route.js";
import { confirmTask, newTask, TASKS_DIR } from "../task/tasks.js";
import { shipTask, trustsJudge } from "./ship.js";

const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-10T18:00:00Z") };

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

const BASE = {
  "package.json": `${JSON.stringify({ name: "demo", scripts: { test: "node --test" } }, null, 2)}\n`,
  "src/total.js": "exports.total = () => 0;\n",
};

async function repo(): Promise<string> {
  const dir = await tmp("rivetari-judge-check-");
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  for (const [path, text] of Object.entries(BASE)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), text);
  }
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  return dir;
}

function profile(dir: string, ci: string): Promise<void> {
  return writeFile(
    join(dir, ".rivetari", "profile.yml"),
    `version: 1\nname: demo\ntype: web-app\n${ci}`,
  );
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
});

const review: typeof reviewLocal = async (o) => {
  const result: Tier2Result = {
    verdict: "approve",
    blocking: [],
    suggestions: [],
    acceptance: [{ id: "A1", status: "met", note: "" }],
    unreviewed: [],
    model: "judge-model",
    calls: 1,
    usage: { tokens: 100, costUsd: 0.01 },
    packed: {
      files: [],
      omitted: [],
      lines: new Map(),
      agents: null,
      constraints: null,
    },
  };
  const round = o.round ?? 1;
  return {
    verdict: roundVerdict(result, round),
    round,
    result,
    body: "review",
  };
};

/** Intake to a passed judge round: the task is ready to ship. */
async function judged(dir: string): Promise<{ id: string; head: string }> {
  const { manifests } = await loadManifests(dir);
  const context: RouteContext = {
    manifests,
    available: new Set(),
    flags: {},
    files: Object.keys(BASE),
    checks: ["quality.tests.pass"],
  };
  const draft = await newTask(
    dir,
    {
      title: "Fix total so it sums",
      type: "fix",
      description: "total() returns 0; it should sum its list.",
      acceptance: [{ id: "A1", text: "total sums a list", verify: "unit" }],
    },
    by,
  );
  const id = draft.card.id;
  await confirmTask(dir, id, by);
  await routeTask(dir, id, { ...by, context });
  await approveRoute(dir, id, { ...by, context });
  await isolateTask(dir, id, { ...by, base: "main" });
  await buildTask(dir, id, {
    ...by,
    agent: async (call) => {
      if (call.mode === "plan")
        return { text: JSON.stringify({ steps: ["fix total"] }), tokens: 1 };
      await writeFile(
        join(call.cwd, "src/total.js"),
        "exports.total = (l) => l.reduce((a, b) => a + b, 0);\n",
      );
      return { text: "fixed total", tokens: 1 };
    },
  });
  await proveTask(dir, id, by);
  const { record } = await judgeTask(dir, id, { ...by, tier1, review });
  expect(record.verdict).toBe("passed");
  return { id, head: record.head };
}

function ship(dir: string, id: string, posted: JudgeCheckParams[]) {
  return shipTask(dir, id, {
    ...by,
    push: async () => undefined,
    openPr: async () => ({
      number: 5,
      url: "https://github.com/o/r/pull/5",
      reused: false,
    }),
    postReview: async () => null,
    postCheck: async (p) => {
      posted.push(p);
      return "https://github.com/o/r/runs/9";
    },
  });
}

describe("the rivetari/judge check on ship", { timeout: 180_000 }, () => {
  it("posts it on the judged head with the record's sha256 and the ledger hash when trust_judge is true", async () => {
    const dir = await repo();
    const { id, head } = await judged(dir);
    await profile(dir, "ci:\n  trust_judge: true\n");
    const before = (
      await readFile(join(dir, TASKS_DIR, id, "ledger.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { mac: string });
    const posted: JudgeCheckParams[] = [];

    const shipped = await ship(dir, id, posted);

    const record = await readFile(
      join(dir, TASKS_DIR, id, "judge", "round-1.json"),
      "utf8",
    );
    expect(posted).toEqual([
      {
        head,
        task: id,
        round: 1,
        recordSha256: createHash("sha256").update(record).digest("hex"),
        ledgerHash: before.at(-1)!.mac,
      },
    ]);
    expect(shipped.task.entries.map((e) => e.text)).toContain(
      "judge check posted: https://github.com/o/r/runs/9",
    );
  });

  it("posts nothing when trust_judge is false", async () => {
    const dir = await repo();
    const { id } = await judged(dir);
    await profile(dir, "ci:\n  trust_judge: false\n");
    const posted: JudgeCheckParams[] = [];

    const shipped = await ship(dir, id, posted);

    expect(posted).toEqual([]);
    expect(
      shipped.task.entries.some((e) => e.text.startsWith("judge check")),
    ).toBe(false);
  });

  it("ships anyway, saying why, when the check can't be posted", async () => {
    const dir = await repo();
    const { id } = await judged(dir);
    const shipped = await shipTask(dir, id, {
      ...by,
      trustJudge: true,
      push: async () => undefined,
      openPr: async () => ({
        number: 5,
        url: "https://github.com/o/r/pull/5",
        reused: false,
      }),
      postReview: async () => null,
      postCheck: () =>
        Promise.reject(new Error("Resource not accessible by integration")),
    });
    const texts = shipped.task.entries.map((e) => e.text);
    expect(texts).toContain(
      "judge check not posted (ship goes on): Resource not accessible by integration",
    );
    expect(texts.some((t) => t.startsWith("draft PR opened: #5"))).toBe(true);
  });
});

describe("trustsJudge", () => {
  async function appOwnedBy(owner: string): Promise<void> {
    const config = process.env.RIVETARI_CONFIG_DIR!;
    await writeFile(
      join(config, "app.json"),
      JSON.stringify({ id: 1, slug: "rivetari-x", clientId: "c", owner }),
    );
    await writeFile(join(config, "app.pem"), "key");
  }

  it("defaults to true on the App owner's repos and false on anyone else's", async () => {
    const dir = await repo();
    await simpleGit(dir).addRemote("origin", "https://github.com/acme/demo");
    await appOwnedBy("Acme");
    expect(await trustsJudge(dir)).toBe(true);
    await appOwnedBy("someone-else");
    expect(await trustsJudge(dir)).toBe(false);
  });

  it("follows the profile's ci.trust_judge over the default", async () => {
    const dir = await repo();
    await simpleGit(dir).addRemote("origin", "https://github.com/acme/demo");
    await appOwnedBy("acme");
    await mkdir(join(dir, ".rivetari"), { recursive: true });
    await profile(dir, "ci:\n  trust_judge: false\n");
    expect(await trustsJudge(dir)).toBe(false);
  });

  it("is false with no App registered", async () => {
    const dir = await repo();
    await simpleGit(dir).addRemote("origin", "https://github.com/acme/demo");
    expect(await trustsJudge(dir)).toBe(false);
  });
});
