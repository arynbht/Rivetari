import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentCall } from "../agent/build.js";
import { remoteDatabaseHost } from "../agent/stops.js";
import type { reviewLocal } from "../judge/review.js";
import type { Tier1Options, Tier1Result } from "../judge/tier1.js";
import type { RouteContext } from "../router/task-route.js";
import type { OpenPrParams } from "@arynbht/rivetari-engine";
import {
  advanceTask,
  autonomyFor,
  isSoftStop,
  routeConcerns,
} from "./autonomy.js";
import { runTask } from "./run.js";
import { loadTask, newTask, nextStep } from "./tasks.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-21T18:00:00Z") };

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

const profile = (autonomy: string) =>
  `version: 1\nname: demo\ntype: library\nautonomy: ${autonomy}\n`;

async function repoWith(
  autonomy: string | null,
  extra: Record<string, string> = {},
): Promise<{ repo: string; context: RouteContext }> {
  const repo = await tmp("rivetari-autonomy-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  const files: Record<string, string> = {
    "package.json": `${JSON.stringify({ name: "demo", scripts: { test: "node --test" } }, null, 2)}\n`,
    "src/total.js": "exports.total = () => 0;\n",
    ...(autonomy ? { ".rivetari/profile.yml": profile(autonomy) } : {}),
    ...extra,
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  const { manifests } = await loadManifests(repo);
  return {
    repo,
    context: {
      manifests,
      available: new Set(),
      flags: {},
      files: Object.keys(files),
      checks: ["quality.tests.pass"],
    },
  };
}

const card = (extra: Record<string, unknown> = {}) => ({
  title: "Fix total so it sums",
  type: "fix" as const,
  description: "total() returns 0; it should sum its list.",
  acceptance: [
    { id: "A1", text: "total sums a list", verify: "unit" as const },
  ],
  ...extra,
});

const FIXED = "exports.total = (l) => l.reduce((a, b) => a + b, 0);\n";
const TEST =
  'const t = require("node:test"); const a = require("node:assert"); const { total } = require("./total.js");\nt.test("sums", () => a.equal(total([1, 2, 3]), 6));\n';

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

describe("autonomy levels", () => {
  it("reads the repo's level, and keeps a high-risk task supervised", async () => {
    const { repo } = await repoWith("review-at-pr");
    const low = await newTask(repo, card(), by);
    const high = await newTask(repo, card({ risk: "high" }), by);
    expect(await autonomyFor(repo, low.card)).toBe("review-at-pr");
    expect(await autonomyFor(repo, high.card)).toBe("supervised");
    const { repo: plain } = await repoWith(null);
    const task = await newTask(plain, card(), by);
    expect(await autonomyFor(plain, task.card)).toBe("supervised");
  });

  it("splits stops into soft ones it flags and hard ones it asks about", () => {
    expect(isSoftStop({ trigger: "schema_change", detail: "x" })).toBe(true);
    expect(
      isSoftStop({ trigger: "new_dependency", detail: "x", osi: true }),
    ).toBe(true);
    expect(
      isSoftStop({ trigger: "new_dependency", detail: "x", osi: false }),
    ).toBe(false);
    expect(
      isSoftStop({
        trigger: "protected_path",
        detail: "x",
        reason: "existing-test",
      }),
    ).toBe(true);
    for (const reason of [
      "ci-config",
      "lint-config",
      "rivetari-state",
    ] as const)
      expect(
        isSoftStop({ trigger: "protected_path", detail: "x", reason }),
      ).toBe(false);
    for (const trigger of [
      "secret",
      "database_url",
      "history_rewritten",
      "sensitive_path",
      "no_change",
      "agent_question",
    ] as const)
      expect(isSoftStop({ trigger, detail: "x" })).toBe(false);
  });

  it("tells a DATABASE_URL that points away from this machine", () => {
    expect(
      remoteDatabaseHost(
        "DATABASE_URL=postgres://app:pw@db.prod.example.com:5432/app",
      ),
    ).toBe("db.prod.example.com");
    expect(
      remoteDatabaseHost('DATABASE_URL: "postgres://localhost:5432/app"'),
    ).toBeUndefined();
    expect(
      remoteDatabaseHost("DATABASE_URL=postgres://u:p@127.0.0.1/app"),
    ).toBeUndefined();
    expect(
      remoteDatabaseHost("DATABASE_URL=postgres://u:p@${DB_HOST}/app"),
    ).toBeUndefined();
    expect(remoteDatabaseHost("const url = process.env.DATABASE_URL;")).toBe(
      undefined,
    );
  });

  it("asks about a route with a borderline sector or a sensitive path", async () => {
    const { repo } = await repoWith("review-at-pr");
    const task = await newTask(
      repo,
      card({ touches: ["src/auth/session.js", "src/total.js"] }),
      by,
    );
    const assembly = {
      stop_and_ask: ["new_dependency", { touches: ["**/payments/**"] }],
    } as unknown as Parameters<typeof routeConcerns>[1];
    expect(routeConcerns(task.card, assembly, ["workflow"])).toEqual([
      "borderline sector(s): workflow",
      "touches sensitive paths: src/auth/session.js",
    ]);
    const plain = await newTask(repo, card({ touches: ["src/total.js"] }), by);
    expect(routeConcerns(plain.card, assembly, [])).toEqual([]);
  });

  it("confirms the card and approves the route without asking at review-at-pr", async () => {
    const { repo, context } = await repoWith("review-at-pr");
    const draft = await newTask(repo, card({ touches: ["src/total.js"] }), by);
    const advance = await advanceTask(repo, draft.card.id, { ...by, context });
    expect(advance.waiting).toBeUndefined();
    expect(advance.task.confirmed).toBe(true);
    expect(advance.task.approved).toBe(true);
    expect(nextStep(advance.task)).toMatch(/^isolate:/);
    expect(advance.task.entries.map((e) => e.by)).toContain(
      "rivetari runtime (autonomy review-at-pr, for dev@example.com)",
    );
  });

  it("stops at the route, with the evidence, when it touches a sensitive path", async () => {
    const { repo, context } = await repoWith("review-at-pr");
    const draft = await newTask(
      repo,
      card({ touches: ["src/billing/invoice.js"] }),
      by,
    );
    const advance = await advanceTask(repo, draft.card.id, { ...by, context });
    expect(advance.task.confirmed).toBe(true);
    expect(advance.task.approved).toBe(false);
    expect(advance.waiting).toContain(
      "touches sensitive paths: src/billing/invoice.js",
    );
  });

  it("leaves a supervised task, and a high-risk one, for a person", async () => {
    const { repo, context } = await repoWith("review-at-pr");
    const high = await newTask(repo, card({ risk: "high" }), by);
    const advance = await advanceTask(repo, high.card.id, { ...by, context });
    expect(advance.level).toBe("supervised");
    expect(advance.task.confirmed).toBe(false);
  });
});

describe("a review-at-pr run", { timeout: 180_000 }, () => {
  it("goes from a draft card to a draft PR with no prompts, and the PR shows the card, the route and the soft stops", async () => {
    const { repo, context } = await repoWith("review-at-pr", {
      "src/total.test.js":
        'const t = require("node:test"); const a = require("node:assert"); const { total } = require("./total.js");\nt.test("returns 0", () => a.equal(total([]), 0));\n',
    });
    const draft = await newTask(repo, card({ touches: ["src/total.js"] }), by);
    const opened: OpenPrParams[] = [];
    const outcome = await runTask(repo, draft.card.id, {
      ...by,
      base: "main",
      context,
      agent: async (call: AgentCall) => {
        if (call.mode === "plan")
          return JSON.stringify({ steps: ["fix total and its test"] });
        await writeFile(join(call.cwd, "src/total.js"), FIXED);
        await writeFile(join(call.cwd, "src/total.test.js"), TEST);
        return "fixed total and updated its test";
      },
      judge: { tier1, review },
      ship: {
        push: async () => undefined,
        openPr: async (p) => {
          opened.push(p);
          return { number: 9, url: "https://x/pull/9", reused: false };
        },
        postReview: async () => null,
      },
    });
    expect(outcome.ran).toEqual(["isolate", "build", "prove", "judge", "ship"]);
    const texts = outcome.task.entries.map((e) => e.text);
    expect(texts.filter((t) => t.startsWith("asked: "))).toEqual([]);
    expect(texts).toContain(
      "flagged: protected_path: src/total.test.js — modifies a test that existed at base",
    );
    const body = opened[0]?.body ?? "";
    expect(body).toContain("## Decisions you would have been asked");
    expect(body).toContain(
      "| protected_path | src/total.test.js — modifies a test that existed at base |",
    );
    expect(body).toContain(
      '-t.test("returns 0", () => a.equal(total([]), 0));',
    );
    expect(body).toContain("<details><summary>Card</summary>");
    expect(body).toContain("title: Fix total so it sums");
    expect(body).toContain("<details><summary>Route</summary>");
    expect(body).toContain("proof: test-run");
  });

  it("still stops on a hard stop: a secret in the change", async () => {
    const { repo, context } = await repoWith("review-at-pr");
    const draft = await newTask(repo, card({ touches: ["src/total.js"] }), by);
    const outcome = await runTask(repo, draft.card.id, {
      ...by,
      base: "main",
      context,
      agent: async (call: AgentCall) => {
        if (call.mode === "plan")
          return JSON.stringify({ steps: ["fix total"] });
        await writeFile(join(call.cwd, "src/total.js"), FIXED);
        await writeFile(
          join(call.cwd, "src/config.js"),
          'exports.key = "AKIAIOSFODNN7EXAMPLE";\n',
        );
        return "fixed";
      },
    });
    expect(outcome.ran).toEqual(["isolate", "build"]);
    expect(outcome.next).toMatch(/^stop-and-ask/);
    expect(outcome.task.entries.map((e) => e.text)).toContain(
      "asked: secret: src/config.js adds a line that looks like a secret",
    );
  });

  it("flags a new dependency whose installed license is on the OSI list, and asks about one it can't check", async () => {
    const { repo, context } = await repoWith("review-at-pr", {
      ".gitignore": "node_modules\n",
    });
    const draft = await newTask(repo, card({ touches: ["src/total.js"] }), by);
    const id = draft.card.id;
    const outcome = await runTask(repo, id, {
      ...by,
      base: "main",
      context,
      agent: async (call: AgentCall) => {
        if (call.mode === "plan")
          return JSON.stringify({ steps: ["add two packages"] });
        const pkg = JSON.parse(
          await readFile(join(call.cwd, "package.json"), "utf8"),
        ) as Record<string, unknown>;
        await writeFile(
          join(call.cwd, "package.json"),
          JSON.stringify({
            ...pkg,
            dependencies: { "left-pad": "^1.3.0", mystery: "^1.0.0" },
          }),
        );
        await mkdir(join(call.cwd, "node_modules", "left-pad"), {
          recursive: true,
        });
        await writeFile(
          join(call.cwd, "node_modules", "left-pad", "package.json"),
          JSON.stringify({ name: "left-pad", license: "MIT" }),
        );
        return "added";
      },
    });
    expect(outcome.next).toMatch(/^stop-and-ask/);
    const task = await loadTask(repo, id);
    expect(task.entries.map((e) => e.text)).toContain(
      "asked: new_dependency: package.json adds left-pad, mystery (left-pad: MIT, mystery: license unknown; not all on the OSI list)",
    );
  });

  it("flags a new dependency when every installed license is on the OSI list", async () => {
    const { repo, context } = await repoWith("review-at-pr", {
      ".gitignore": "node_modules\n",
    });
    const draft = await newTask(repo, card({ touches: ["src/total.js"] }), by);
    const outcome = await runTask(repo, draft.card.id, {
      ...by,
      base: "main",
      context,
      agent: async (call: AgentCall) => {
        if (call.mode === "plan")
          return JSON.stringify({ steps: ["add left-pad"] });
        const pkg = JSON.parse(
          await readFile(join(call.cwd, "package.json"), "utf8"),
        ) as Record<string, unknown>;
        await writeFile(
          join(call.cwd, "package.json"),
          JSON.stringify({ ...pkg, dependencies: { "left-pad": "^1.3.0" } }),
        );
        await mkdir(join(call.cwd, "node_modules", "left-pad"), {
          recursive: true,
        });
        await writeFile(
          join(call.cwd, "node_modules", "left-pad", "package.json"),
          JSON.stringify({ name: "left-pad", license: "MIT" }),
        );
        return "added";
      },
      prove: {
        publish: async () => null,
      },
      judge: { tier1, review },
      ship: {
        push: async () => undefined,
        openPr: async () => ({ number: 1, url: "u", reused: false }),
        postReview: async () => null,
      },
    });
    expect(outcome.task.entries.map((e) => e.text)).toContain(
      "flagged: new_dependency: package.json adds left-pad",
    );
    expect(
      outcome.task.entries.filter((e) => e.text.startsWith("asked: ")),
    ).toEqual([]);
  });
});
