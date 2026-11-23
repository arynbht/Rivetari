// Isolate and build on a real repo with a scripted agent: the worktree, the
// prompt it gets, plan-first, and stop-and-ask (a new dependency pauses it).
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
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
import { confirmTask, loadTask, newTask, nextStep } from "../task/tasks.js";
import { type AgentCall, answerStops, buildTask } from "./build.js";
import { isolateTask, loadIsolation } from "./isolate.js";

const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const savedSecret = process.env.RIVETARI_TEST_SECRET;
let repo: string;
let context: RouteContext;
const by = { by: "dev@example.com", now: new Date("2026-11-10T16:00:00Z") };

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
  process.env.RIVETARI_TEST_SECRET = "caller-token";
  repo = await tmp("rivetari-agent-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(
    join(repo, "AGENTS.md"),
    "# Contract\nKeep functions small.\n",
  );
  await writeFile(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "demo", dependencies: { zod: "^4.0.0" } }, null, 2)}\n`,
  );
  await writeFile(join(repo, "src/total.ts"), "export const total = 0;\n");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  const { manifests } = await loadManifests(repo);
  context = {
    manifests,
    available: new Set(),
    flags: {},
    files: ["src/total.ts"],
    checks: ["quality.tests.pass"],
  };
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  if (savedSecret === undefined) delete process.env.RIVETARI_TEST_SECRET;
  else process.env.RIVETARI_TEST_SECRET = savedSecret;
  for (const d of made) {
    await simpleGit(d)
      .raw(["worktree", "prune"])
      .catch(() => undefined);
    await rm(d, { recursive: true, force: true });
  }
  made.length = 0;
});

async function approvedTask(): Promise<string> {
  const draft = await newTask(
    repo,
    {
      title: "Fix the total query",
      type: "fix",
      description: "total should sum the order lines.",
      acceptance: [{ id: "A1", text: "total sums lines", verify: "unit" }],
      touches: ["src/total.ts"],
    },
    by,
  );
  const id = draft.card.id;
  await confirmTask(repo, id, by);
  await routeTask(repo, id, { ...by, context });
  await approveRoute(repo, id, { ...by, context });
  return id;
}

/** An agent that plans `steps` and, when building, runs `edit` in the worktree. */
function scripted(
  edit: (cwd: string) => Promise<void>,
  steps: string[] = ["Sum the lines in src/total.ts", "Add a test"],
) {
  const calls: AgentCall[] = [];
  const agent = async (call: AgentCall) => {
    calls.push(call);
    if (call.mode === "plan") return JSON.stringify({ steps });
    await edit(call.cwd);
    return "Summed the lines.";
  };
  return { agent, calls };
}

describe("isolate", () => {
  it("cuts a worktree per task with its own branch, port and no hooks", async () => {
    const id = await approvedTask();
    const { isolation, task } = await isolateTask(repo, id, {
      ...by,
      base: "main",
    });
    expect(isolation.branch).toBe("fix/t-0001");
    expect(isolation.port).toBe(5174);
    expect(isolation.worktree).toBe(join(repo, ".worktrees", id));
    const wt = simpleGit(isolation.worktree);
    expect((await wt.revparse(["--abbrev-ref", "HEAD"])).trim()).toBe(
      "fix/t-0001",
    );
    expect(
      (await wt.raw(["config", "--worktree", "core.hooksPath"])).trim(),
    ).toMatch(/rivetari-no-hooks$/);
    // The worktree never shows up as untracked in the primary checkout.
    expect(await simpleGit(repo).raw(["status", "--porcelain"])).not.toContain(
      ".worktrees",
    );
    expect(nextStep(task)).toMatch(/^build: /);
    await expect(
      isolateTask(repo, id, { ...by, base: "main" }),
    ).rejects.toThrow("already has a worktree");
  });

  it("won't isolate before the route is approved", async () => {
    const draft = await newTask(
      repo,
      {
        title: "x",
        type: "fix",
        description: "x",
        acceptance: [{ id: "A1", text: "x", verify: "unit" }],
      },
      by,
    );
    await expect(
      isolateTask(repo, draft.card.id, { ...by, base: "main" }),
    ).rejects.toThrow("isn't approved");
  });
});

describe("build", () => {
  it("plans first, gives the agent the contract and rules, and commits its change", async () => {
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    const { agent, calls } = scripted((cwd) =>
      writeFile(
        join(cwd, "src/total.ts"),
        "export const total = (l: number[]) => l.reduce((a, b) => a + b, 0);\n",
      ),
    );
    const outcome = await buildTask(repo, id, { ...by, agent });
    expect(outcome.stops).toEqual([]);
    expect(calls.map((c) => c.mode)).toEqual(["plan", "build"]);
    const build = calls[1];
    expect(build?.prompt).toContain("Keep functions small.");
    expect(build?.prompt).toContain("# Task card T-0001");
    expect(build?.prompt).toContain("### src/total.ts");
    expect(build?.prompt).toContain("1. Sum the lines in src/total.ts");
    expect(build?.prompt).toContain("port is 5174");
    // The agent runs repo code: no caller tokens in its environment.
    expect(build?.env.RIVETARI_TEST_SECRET).toBeUndefined();
    expect(build?.env.PORT).toBe("5174");

    const iso = await loadIsolation(repo, id);
    const log = await simpleGit(iso?.worktree ?? "").log();
    expect(log.latest?.message).toBe("fix(t-0001): Fix the total query");
    const ledger = await readFile(outcome.task.ledger.mdPath, "utf8");
    expect(ledger).toContain("## Plan");
    expect(ledger).toContain("build done · commit ");
    expect(nextStep(outcome.task)).toBe("prove");
  });

  it("pauses on a new dependency until a person answers", async () => {
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    const addDep = async (cwd: string) => {
      const path = join(cwd, "package.json");
      const pkg = JSON.parse(await readFile(path, "utf8")) as {
        dependencies: Record<string, string>;
      };
      pkg.dependencies["left-pad"] = "^1.3.0";
      await writeFile(path, JSON.stringify(pkg, null, 2));
    };
    const first = await buildTask(repo, id, {
      ...by,
      agent: scripted(addDep).agent,
    });
    expect(first.stops).toEqual([
      { trigger: "new_dependency", detail: "package.json adds left-pad" },
    ]);
    expect(nextStep(first.task)).toMatch(/^stop-and-ask: /);
    await expect(
      buildTask(repo, id, { ...by, agent: scripted(addDep).agent }),
    ).rejects.toThrow("waiting on an answer");

    // Denied: the next round is told, and undoes it.
    let task = await answerStops(repo, id, {
      allow: false,
      note: "use Array.prototype.padStart",
      by: "dev@example.com",
    });
    expect(nextStep(task)).toMatch(/^build: /);
    const undo = scripted(async (cwd) => {
      await writeFile(
        join(cwd, "package.json"),
        `${JSON.stringify({ name: "demo", dependencies: { zod: "^4.0.0" } }, null, 2)}\n`,
      );
    });
    const second = await buildTask(repo, id, { ...by, agent: undo.agent });
    expect(undo.calls.map((c) => c.mode)).toEqual(["build"]); // the plan stands
    expect(undo.calls[0]?.prompt).toContain(
      "Since your last round: denied — use Array.prototype.padStart",
    );
    expect(second.stops).toEqual([]);
    task = await loadTask(repo, id);
    expect(nextStep(task)).toBe("prove");
  });

  it("an allowed stop isn't asked again, and the task moves on", async () => {
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    const addDep = async (cwd: string) => {
      await writeFile(
        join(cwd, "package.json"),
        JSON.stringify({
          name: "demo",
          dependencies: { zod: "^4.0.0", ms: "^2.1.3" },
        }),
      );
    };
    await buildTask(repo, id, { ...by, agent: scripted(addDep).agent });
    const task = await answerStops(repo, id, {
      allow: true,
      by: "dev@example.com",
    });
    expect(nextStep(task)).toBe("prove");
  });

  it("stops before building when the plan is over budget", async () => {
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    const long = Array.from({ length: 13 }, (_, i) => `step ${i + 1}`);
    const { agent, calls } = scripted(async () => undefined, long);
    const outcome = await buildTask(repo, id, { ...by, agent });
    expect(calls.map((c) => c.mode)).toEqual(["plan"]);
    expect(outcome.stops[0]).toEqual({
      trigger: "budget_exhausted",
      detail: "the plan has 13 steps; the budget is 12",
    });
    // Allowed: the build runs on the plan as written.
    const task = await answerStops(repo, id, {
      allow: true,
      by: "dev@example.com",
    });
    expect(nextStep(task)).toMatch(/^build: /);
  });

  it("asks about edits to protected paths and existing tests", async () => {
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    const { agent } = scripted(async (cwd) => {
      await mkdir(join(cwd, ".github/workflows"), { recursive: true });
      await writeFile(join(cwd, ".github/workflows/ci.yml"), "on: push\n");
    });
    const outcome = await buildTask(repo, id, { ...by, agent });
    expect(outcome.stops.map((s) => s.trigger)).toEqual(["protected_path"]);
  });

  it("asks a person when the agent changed nothing, with what it said", async () => {
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    const calls: AgentCall[] = [];
    const agent = async (call: AgentCall) => {
      calls.push(call);
      if (call.mode === "plan")
        return JSON.stringify({ steps: ["Ask before changing the test"] });
      return "I haven't changed anything: the test needs the owner's approval first.";
    };
    const outcome = await buildTask(repo, id, { ...by, agent });
    expect(outcome.stops).toEqual([
      {
        trigger: "no_change",
        detail:
          "I haven't changed anything: the test needs the owner's approval first.",
      },
    ]);
    expect(nextStep(outcome.task)).toMatch(/^stop-and-ask/);
    // The agent is told it can't ask mid-round, and to make the change instead.
    expect(calls[1]?.prompt).toContain("You can't ask during the round.");
  });

  it("an answered RIVETARI_STOP question goes back to the agent, with the answer", async () => {
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    const first = await buildTask(repo, id, {
      ...by,
      agent: async (call) =>
        call.mode === "plan"
          ? JSON.stringify({ steps: ["Sum the lines"] })
          : "Before I start:\nRIVETARI_STOP: May total() ignore blank lines?",
    });
    expect(first.stops).toEqual([
      {
        trigger: "agent_question",
        detail: "May total() ignore blank lines?",
      },
    ]);
    const answered = await answerStops(repo, id, {
      allow: true,
      note: "yes, skip them",
      by: "dev@example.com",
    });
    expect(nextStep(answered)).toMatch(/^build:/);
    const next = scripted(async (cwd) => {
      await writeFile(join(cwd, "src/total.ts"), "export const total = 1;\n");
    });
    const outcome = await buildTask(repo, id, { ...by, agent: next.agent });
    expect(outcome.stops).toEqual([]);
    expect(next.calls[0]?.prompt).toContain(
      "Since your last round: a person answered your question (allowed): yes, skip them",
    );
  });

  it("gives a retry round its change so far and the failure, not the repo slice again", async () => {
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    const calls: AgentCall[] = [];
    let round = 0;
    const agent = async (call: AgentCall) => {
      calls.push(call);
      if (call.mode === "plan")
        return JSON.stringify({ steps: ["Sum the lines"] });
      round++;
      await writeFile(
        join(call.cwd, "src/total.ts"),
        `export const total = ${round};\n`,
      );
      return "Summed the lines.";
    };
    await buildTask(repo, id, { ...by, agent });
    const first = calls.find((c) => c.mode === "build")?.prompt ?? "";
    expect(first).toContain("# Operating rules");
    expect(first).not.toContain("# Your change so far");

    const task = await loadTask(repo, id);
    await task.ledger.append({
      beat: "prove",
      section: "proof",
      text: "tests failed (pnpm run test, exit 1) · total([]) throws",
      by: "rivetari runtime (for dev@example.com)",
    });
    await task.ledger.append({
      beat: "prove",
      section: "timeline",
      text: "proof failed · test-run",
      by: "rivetari runtime (for dev@example.com)",
    });
    calls.length = 0;
    await buildTask(repo, id, { ...by, agent });
    expect(calls.map((c) => c.mode)).toEqual(["build"]);
    const retry = calls[0]?.prompt ?? "";
    expect(retry).toContain(
      "# Your change so far (git diff from the base, in this worktree)",
    );
    expect(retry).toContain("+export const total = 1;");
    expect(retry).toContain(
      "Since your last round: the proof failed; fix the change so it passes — tests failed (pnpm run test, exit 1) · total([]) throws",
    );
    expect(retry).toContain("# Task card");
    expect(retry).toContain("# Operating rules");
    expect(first).toContain("## Repository files");
    expect(retry).not.toContain("## Repository files");
    expect(calls[0]?.system).toContain("RIVETARI_STOP:");
  });

  it("doesn't stop on a test file that names a secret as data, but does on a real key shape in one", async () => {
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    const fixture = await buildTask(repo, id, {
      ...by,
      agent: scripted(async (cwd) => {
        await writeFile(
          join(cwd, "src/stops.test.ts"),
          'const detail = "x";\nexpect(line).toBe(`secret: ${detail}`);\nconst stop = { trigger: "secret", detail: "a-long-enough-value" };\nsecret: "aaaaaaaaaaaa";\n',
        );
      }).agent,
    });
    expect(fixture.stops.map((s) => s.trigger)).not.toContain("secret");

    const id2 = await approvedTask();
    await isolateTask(repo, id2, { ...by, base: "main" });
    const key = await buildTask(repo, id2, {
      ...by,
      agent: scripted(async (cwd) => {
        await writeFile(
          join(cwd, "src/aws.test.ts"),
          'const key = "AKIAIOSFODNN7EXAMPLE";\n',
        );
      }).agent,
    });
    expect(key.stops).toContainEqual({
      trigger: "secret",
      detail: "src/aws.test.ts adds a line that looks like a secret",
    });
  });

  it("doesn't stop on a rebuilt bundle, but does on a real key shape in source", async () => {
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    const bundle = await buildTask(repo, id, {
      ...by,
      agent: scripted(async (cwd) => {
        await mkdir(join(cwd, "packages/action/dist"), { recursive: true });
        await writeFile(
          join(cwd, "packages/action/dist/index.js"),
          'var e={token:"ghs_bundledvalue1234"};const AK="AKIAIOSFODNN7EXAMPLE";\n',
        );
        await writeFile(join(cwd, "src/total.ts"), "export const total = 2;\n");
      }).agent,
    });
    expect(bundle.stops.map((s) => s.trigger)).not.toContain("secret");

    const id2 = await approvedTask();
    await isolateTask(repo, id2, { ...by, base: "main" });
    const key = await buildTask(repo, id2, {
      ...by,
      agent: scripted(async (cwd) => {
        await mkdir(join(cwd, "packages/action/dist"), { recursive: true });
        await writeFile(
          join(cwd, "packages/action/dist/index.js"),
          'const AK="AKIAIOSFODNN7EXAMPLE";\n',
        );
        await writeFile(
          join(cwd, "src/config.ts"),
          'export const key = "AKIAIOSFODNN7EXAMPLE";\n',
        );
      }).agent,
    });
    expect(key.stops).toContainEqual({
      trigger: "secret",
      detail: "src/config.ts adds a line that looks like a secret",
    });
    expect(key.stops.map((s) => s.detail)).not.toContain(
      "packages/action/dist/index.js adds a line that looks like a secret",
    );
  });

  it("replans, never runs, a plan whose budget stop was denied", async () => {
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    const long = Array.from({ length: 13 }, (_, i) => `step ${i + 1}`);
    await buildTask(repo, id, {
      ...by,
      agent: scripted(async () => undefined, long).agent,
    });
    await answerStops(repo, id, {
      allow: false,
      note: "five steps at most",
      by: "dev@example.com",
    });
    const short = scripted(
      async (cwd) => {
        await writeFile(join(cwd, "src/total.ts"), "export const total = 1;\n");
      },
      ["one", "two"],
    );
    const outcome = await buildTask(repo, id, { ...by, agent: short.agent });
    expect(short.calls.map((c) => c.mode)).toEqual(["plan", "build"]);
    expect(short.calls[0]?.prompt).toContain(
      "your plan was over budget and was refused — five steps at most",
    );
    // The build runs the new plan, and isn't told to undo anything.
    expect(short.calls[1]?.prompt).toContain("1. one");
    expect(short.calls[1]?.prompt).not.toContain("step 13");
    expect(short.calls[1]?.prompt).not.toContain("Since your last round");
    expect(outcome.stops).toEqual([]);
  });

  it("passes a denial to the next round only", async () => {
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    await buildTask(repo, id, {
      ...by,
      agent: scripted((cwd) =>
        writeFile(
          join(cwd, "package.json"),
          JSON.stringify({
            name: "demo",
            dependencies: { zod: "^4.0.0", ms: "^2.1.3" },
          }),
        ),
      ).agent,
    });
    await answerStops(repo, id, {
      allow: false,
      note: "no ms",
      by: "dev@example.com",
    });
    const undo = scripted((cwd) =>
      writeFile(
        join(cwd, "package.json"),
        `${JSON.stringify({ name: "demo", dependencies: { zod: "^4.0.0" } }, null, 2)}\n`,
      ),
    );
    await buildTask(repo, id, { ...by, agent: undo.agent });
    expect(undo.calls[0]?.prompt).toContain("denied — no ms");
    const later = scripted(async () => undefined);
    await buildTask(repo, id, { ...by, agent: later.agent });
    expect(later.calls[0]?.prompt).not.toContain("Since your last round");
  });

  it("asks when a workspace package's scripts change", async () => {
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    const { agent } = scripted(async (cwd) => {
      await mkdir(join(cwd, "packages/a"), { recursive: true });
      await writeFile(
        join(cwd, "packages/a/package.json"),
        JSON.stringify({ name: "a", scripts: { test: "exit 0" } }),
      );
    });
    const outcome = await buildTask(repo, id, { ...by, agent });
    expect(outcome.stops.map((s) => s.trigger)).toContain("protected_path");
  });

  it("won't build on an env.json edited after isolation", async () => {
    const id = await approvedTask();
    const { isolation } = await isolateTask(repo, id, { ...by, base: "main" });
    const path = join(repo, ".rivetari/tasks", id, "env.json");
    await writeFile(path, JSON.stringify({ ...isolation, worktree: repo }));
    await expect(
      buildTask(repo, id, {
        ...by,
        agent: scripted(async () => undefined).agent,
      }),
    ).rejects.toThrow("doesn't match the isolation sealed in the ledger");
  });
});

describe("isolate runs no hooks", () => {
  it("not even post-checkout during worktree add", async () => {
    const git = simpleGit(repo, { unsafe: { allowUnsafeHooksPath: true } });
    await mkdir(join(repo, ".husky"), { recursive: true });
    const marker = join(repo, "hook-ran").split("\\").join("/");
    await writeFile(
      join(repo, ".husky/post-checkout"),
      `#!/bin/sh\necho ran > "${marker}"\n`,
    );
    await chmod(join(repo, ".husky/post-checkout"), 0o755);
    await git.add(["-A"]);
    await git.commit("hooks", ["--no-verify"]);
    await git.addConfig("core.hooksPath", ".husky");
    const id = await approvedTask();
    await isolateTask(repo, id, { ...by, base: "main" });
    await expect(access(join(repo, "hook-ran"))).rejects.toThrow();
  });
});

describe("the contract comes from the base", () => {
  it("an edit to CONSTRAINTS.md in the worktree doesn't reach the prompt", async () => {
    await writeFile(join(repo, "CONSTRAINTS.md"), "No global state.\n");
    const git = simpleGit(repo);
    await git.add(["-A"]);
    await git.commit("constraints", ["--no-verify"]);
    const id = await approvedTask();
    const { isolation } = await isolateTask(repo, id, { ...by, base: "main" });
    await writeFile(
      join(isolation.worktree, "CONSTRAINTS.md"),
      "Anything goes.\n",
    );
    const { agent, calls } = scripted(async () => undefined);
    await buildTask(repo, id, { ...by, agent });
    expect(calls[1]?.prompt).toContain("No global state.");
    expect(calls[1]?.prompt).not.toContain("Anything goes.");
  });
});
