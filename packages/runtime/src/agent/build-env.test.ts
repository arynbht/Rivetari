// The build's environment: an "allowed" that names commands lets the next
// round run them, the plan call's turns fit the card, Playwright's browser
// is installed for the version the worktree pins, a port is handed out only
// when it's free, and a server the task started never outlives its round,
// its proof or the task.
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CommandRunner } from "@arynbht/rivetari-engine";
import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { proveTask } from "../proof/prove.js";
import {
  approveRoute,
  type RouteContext,
  routeTask,
} from "../router/task-route.js";
import { closeTask } from "../ship/close.js";
import type { CardInput } from "../task/card.js";
import { confirmTask, loadTask, newTask, nextStep } from "../task/tasks.js";
import {
  type AgentCall,
  agentArgs,
  answerStops,
  buildTask,
  MAX_PLAN_TURNS,
  PLAN_TURNS_ENV,
  planTurns,
} from "./build.js";
import { grantedCommands } from "./grants.js";
import { isolateTask } from "./isolate.js";

const made: string[] = [];
const children: ChildProcess[] = [];
const pids: number[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const savedTurns = process.env[PLAN_TURNS_ENV];
let repo: string;
let context: RouteContext;
const by = { by: "dev@example.com", now: new Date("2026-11-24T16:00:00Z") };

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function makeRepo(pkg: Record<string, unknown>, lock?: object) {
  repo = await tmp("rivetari-build-env-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "AGENTS.md"), "# Contract\n");
  await writeFile(
    join(repo, "package.json"),
    `${JSON.stringify({ name: "demo", ...pkg }, null, 2)}\n`,
  );
  if (lock)
    await writeFile(
      join(repo, "package-lock.json"),
      `${JSON.stringify(lock, null, 2)}\n`,
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
}

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
  delete process.env[PLAN_TURNS_ENV];
  await makeRepo({ dependencies: { zod: "^4.0.0" } });
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  if (savedTurns === undefined) delete process.env[PLAN_TURNS_ENV];
  else process.env[PLAN_TURNS_ENV] = savedTurns;
  for (const pid of pids)
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  for (const c of children) c.kill("SIGKILL");
  pids.length = 0;
  children.length = 0;
  for (const d of made) {
    await simpleGit(d)
      .raw(["worktree", "prune"])
      .catch(() => undefined);
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
  made.length = 0;
});

const CARD: CardInput = {
  title: "Fix the total query",
  type: "fix",
  description: "total should sum the order lines.",
  acceptance: [{ id: "A1", text: "total sums lines", verify: "unit" }],
  touches: ["src/total.ts"],
  risk: "medium",
};

/** An approved task, isolated unless `isolate` is false. */
async function approvedTask(
  card: Partial<CardInput> = {},
  isolate: Parameters<typeof isolateTask>[2] | false = {},
): Promise<{ id: string; worktree: string; port: number }> {
  const draft = await newTask(repo, { ...CARD, ...card }, by);
  const id = draft.card.id;
  await confirmTask(repo, id, by);
  await routeTask(repo, id, { ...by, context });
  await approveRoute(repo, id, { ...by, context });
  if (isolate === false) return { id, worktree: "", port: 0 };
  const { isolation } = await isolateTask(repo, id, {
    ...by,
    base: "main",
    ...isolate,
  });
  return { id, worktree: isolation.worktree, port: isolation.port };
}

const sumLines = (cwd: string) =>
  writeFile(
    join(cwd, "src/total.ts"),
    "export const total = (l: number[]) => l.reduce((a, b) => a + b, 0);\n",
  );

const ledgerOf = async (id: string) =>
  readFile((await loadTask(repo, id)).ledger.mdPath, "utf8");

/** A dev server in `worktree`, started the way a background Bash call starts one, that outlives its caller. */
async function startDevServer(
  worktree: string,
): Promise<{ pid: number; port: number }> {
  const info = join(await tmp("rivetari-dev-info-"), "info.json");
  await writeFile(
    join(worktree, "dev-server.cjs"),
    `const server = require("http").createServer((q, s) => s.end("ok"));
server.listen(0, () => require("fs").writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, port: server.address().port })));
`,
  );
  const child = spawn(
    process.execPath,
    [join(worktree, "dev-server.cjs"), info],
    { detached: true, stdio: "ignore", windowsHide: true },
  );
  child.unref();
  children.push(child);
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const text = await readFile(info, "utf8").catch(() => "");
    if (text) {
      const server = JSON.parse(text) as { pid: number; port: number };
      pids.push(server.pid);
      return server;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the dev server never started");
}

const answers = (port: number) =>
  fetch(`http://127.0.0.1:${port}`, { signal: AbortSignal.timeout(1000) }).then(
    () => true,
    () => false,
  );

describe(
  "R-1: an allowed stop that names commands",
  { timeout: 60_000 },
  () => {
    const QUESTION =
      "RIVETARI_STOP: May I run `npm exec -- playwright install chromium` and then `PORT=5178 npm run e2e` in this worktree to confirm the smoke specs pass (A3)?";

    it("lets the next round run exactly those commands, records them, and tells the agent", async () => {
      const { id } = await approvedTask();
      const calls: AgentCall[] = [];
      let round = 0;
      const agent = async (call: AgentCall) => {
        calls.push(call);
        if (call.mode === "plan") return JSON.stringify({ steps: ["Sum it"] });
        round++;
        await sumLines(call.cwd);
        if (round === 1) return QUESTION;
        if (round === 2)
          await writeFile(join(call.cwd, "src/lines.ts"), "export {};\n");
        return "Ran them; both pass.";
      };
      const first = await buildTask(repo, id, { ...by, agent });
      expect(first.stops.map((s) => s.trigger)).toEqual(["agent_question"]);
      await answerStops(repo, id, {
        allow: true,
        note: "yes to both; `git push origin HEAD` too",
        by: "dev@example.com",
      });

      await buildTask(repo, id, { ...by, agent });
      const second = calls.filter((c) => c.mode === "build")[1];
      // npm exec is denied to the build, so it's granted as npx, the same command.
      expect(second?.allow).toEqual([
        "npx playwright install chromium",
        "PORT=5178 npm run e2e",
      ]);
      const tools = agentArgs(second as AgentCall);
      const allowed = tools[tools.indexOf("--allowedTools") + 1] ?? "";
      expect(allowed.split(",")).toEqual(
        expect.arrayContaining([
          "Bash(npx playwright install chromium)",
          "Bash(PORT=5178 npm run e2e)",
        ]),
      );
      expect(allowed).not.toContain("npm exec");
      expect(allowed).not.toContain("git push");
      expect(second?.prompt).toContain(
        "run each exactly as written: `npx playwright install chromium`, `PORT=5178 npm run e2e`",
      );
      expect(second?.prompt).toContain(
        "`git push origin HEAD` stays blocked: the build never runs `git push`",
      );
      expect(await ledgerOf(id)).toContain(
        "granted for this round: Bash(npx playwright install chromium), Bash(PORT=5178 npm run e2e) · not granted: `git push origin HEAD` (the build never runs `git push`)",
      );
    });

    it("grants nothing when the answer is a denial", async () => {
      const { id } = await approvedTask();
      const calls: AgentCall[] = [];
      const agent = async (call: AgentCall) => {
        calls.push(call);
        if (call.mode === "plan") return JSON.stringify({ steps: ["Sum it"] });
        await sumLines(call.cwd);
        return calls.length <= 2 ? QUESTION : "Done without them.";
      };
      await buildTask(repo, id, { ...by, agent });
      await answerStops(repo, id, { allow: false, by: "dev@example.com" });
      await buildTask(repo, id, { ...by, agent });
      expect(calls.filter((c) => c.mode === "build")[1]?.allow).toBeUndefined();
      expect(await ledgerOf(id)).not.toContain("granted for this round");
    });

    it("only grants single, plain commands the deny list doesn't cover", () => {
      expect(
        grantedCommands([
          "May I run `npm run e2e`, `npm test && rm -rf src`, `node -e 'x'`, `FOO=1 git push`, `npx playwright test --project=chromium`, and read `src/total.ts`?",
        ]),
      ).toEqual({
        commands: ["npm run e2e", "npx playwright test --project=chromium"],
        refused: [
          {
            command: "npm test && rm -rf src",
            why: "it isn't a single plain command (no chaining, pipes, redirects, substitution or globs)",
          },
          { command: "node -e 'x'", why: "the build never runs `node -e`" },
          { command: "FOO=1 git push", why: "the build never runs `git push`" },
        ],
      });
    });
  },
);

describe("R-21: the plan call's turns", { timeout: 60_000 }, () => {
  it("start at eight and grow with the card's criteria, touches and risk, up to a cap", () => {
    expect(
      planTurns({
        acceptance: [{}, {}] as never,
        touches: ["a", "b"],
        risk: "low",
      }),
    ).toBe(8);
    expect(
      planTurns({
        acceptance: [{}, {}, {}, {}, {}] as never,
        touches: ["a", "b", "c", "d", "e"],
        risk: "high",
      }),
    ).toBe(8 + 6 + 2 + 4);
    expect(
      planTurns({
        acceptance: Array.from({ length: 12 }, () => ({})) as never,
        touches: [],
        risk: "high",
      }),
    ).toBe(MAX_PLAN_TURNS);
  });

  it("can be set outright", () => {
    const card = {
      acceptance: [{}] as never,
      touches: [],
      risk: "low" as const,
    };
    expect(planTurns(card, { [PLAN_TURNS_ENV]: "30" })).toBe(30);
    expect(planTurns(card, { [PLAN_TURNS_ENV]: "lots" })).toBe(8);
  });

  it("are what the plan call gets, and what a turn-limit stop offers", async () => {
    const acceptance = ["A1", "A2", "A3", "A4", "A5"].map((id) => ({
      id,
      text: `criterion ${id}`,
      verify: "unit" as const,
    }));
    const { id } = await approvedTask({ acceptance });
    const calls: AgentCall[] = [];
    const outcome = await buildTask(repo, id, {
      ...by,
      agent: async (call) => {
        calls.push(call);
        return { text: "", turnLimit: call.maxTurns };
      },
    });
    expect(calls[0]?.maxTurns).toBe(14);
    expect(outcome.stops).toEqual([
      {
        trigger: "budget_exhausted",
        detail:
          "the plan call reached its 14-turn limit before it replied with a plan; allow to plan again with 28 turns, or deny to plan again within 14",
      },
    ]);
  });
});

describe("R-11: Playwright's browser", { timeout: 60_000 }, () => {
  const PIN = { devDependencies: { "@playwright/test": "1.65.1" } };
  const LOCK = {
    lockfileVersion: 3,
    packages: { "node_modules/@playwright/test": { version: "1.65.1" } },
  };
  const recorder = (exitCode = 0, stderr = "") => {
    const runs: { bin: string; args: string[]; cwd: string }[] = [];
    const run: CommandRunner = async (bin, args, cwd) => {
      runs.push({ bin, args, cwd });
      return { exitCode, stdout: "", stderr };
    };
    return { runs, run };
  };

  it("is installed at isolate for the version the worktree pins", async () => {
    await makeRepo(PIN, LOCK);
    const { runs, run } = recorder();
    const { id, worktree } = await approvedTask({}, { run });
    expect(runs).toEqual([
      {
        bin: "npx",
        args: ["--yes", "playwright@1.65.1", "install", "chromium"],
        cwd: worktree,
      },
    ]);
    expect(await ledgerOf(id)).toContain(
      "playwright browser ready: chromium for playwright 1.65.1 (`npx --yes playwright@1.65.1 install chromium`)",
    );
  });

  it("says plainly when the install fails, and the worktree stays", async () => {
    await makeRepo(PIN, LOCK);
    const { run } = recorder(1, "getaddrinfo ENOTFOUND cdn.playwright.dev");
    const { id } = await approvedTask({}, { run });
    expect(await ledgerOf(id)).toContain(
      "playwright browser not installed: `npx --yes playwright@1.65.1 install chromium` exited 1: getaddrinfo ENOTFOUND cdn.playwright.dev",
    );
    expect(nextStep(await loadTask(repo, id))).toMatch(/^build: /);
  });

  it("is installed again before the proof, for a pin the build added", async () => {
    const { runs, run } = recorder();
    const { id, worktree } = await approvedTask({}, { run });
    expect(runs).toEqual([]);
    await buildTask(repo, id, {
      ...by,
      agent: async (call) => {
        if (call.mode === "plan") return JSON.stringify({ steps: ["Sum it"] });
        await sumLines(call.cwd);
        await writeFile(
          join(call.cwd, "package.json"),
          `${JSON.stringify({ name: "demo", dependencies: { zod: "^4.0.0" }, devDependencies: { "@playwright/test": "^1.65.0" } }, null, 2)}\n`,
        );
        return "Summed, with an e2e harness.";
      },
    });
    await answerStops(repo, id, { allow: true, by: "dev@example.com" });
    await proveTask(repo, id, { ...by, deferTestRun: true, run });
    expect(runs).toEqual([
      {
        bin: "npx",
        args: ["--yes", "playwright@^1.65.0", "install", "chromium"],
        cwd: worktree,
      },
    ]);
    expect(await ledgerOf(id)).toContain(
      "playwright browser ready: chromium for playwright ^1.65.0",
    );
  });

  it("isn't touched when the worktree doesn't use Playwright", async () => {
    const { runs, run } = recorder();
    const { id } = await approvedTask({}, { run });
    expect(runs).toEqual([]);
    expect(await ledgerOf(id)).not.toContain("playwright");
  });
});

describe(
  "R-26 and R-33: the task's servers and ports",
  { timeout: 90_000 },
  () => {
    it("isolate skips a port something is bound to", async () => {
      const asked: number[] = [];
      const { port } = await approvedTask(
        {},
        {
          portFree: async (p) => {
            asked.push(p);
            return p !== 5174;
          },
        },
      );
      expect(asked.slice(0, 2)).toEqual([5174, 5175]);
      expect(port).toBe(5175);
    });

    it("a server the build agent started is stopped when its round ends", async () => {
      const { id } = await approvedTask();
      let server = { pid: 0, port: 0 };
      const outcome = await buildTask(repo, id, {
        ...by,
        agent: async (call) => {
          if (call.mode === "plan")
            return JSON.stringify({ steps: ["Sum it"] });
          await sumLines(call.cwd);
          server = await startDevServer(call.cwd);
          return "Summed; checked it in the browser.";
        },
      });
      expect(outcome.stops).toEqual([]);
      expect(alive(server.pid)).toBe(false);
      expect(await answers(server.port)).toBe(false);
      expect(await ledgerOf(id)).toContain(
        `stopped the task's server on port ${server.port} (pid ${server.pid}: `,
      );
      expect(nextStep(outcome.task)).toBe("prove");
    });

    it("a server the task left running is stopped when it's abandoned", async () => {
      const { id, worktree } = await approvedTask();
      const server = await startDevServer(worktree);
      expect(await answers(server.port)).toBe(true);
      await closeTask(repo, id, { ...by, abandon: "redrafting" });
      expect(alive(server.pid)).toBe(false);
      expect(await answers(server.port)).toBe(false);
      expect(await ledgerOf(id)).toContain(
        `stopped the task's server on port ${server.port}`,
      );
    });

    it("a server still up when the proof runs is stopped after it", async () => {
      const { id, worktree } = await approvedTask();
      await buildTask(repo, id, {
        ...by,
        agent: async (call) => {
          if (call.mode === "plan")
            return JSON.stringify({ steps: ["Sum it"] });
          await sumLines(call.cwd);
          return "Summed.";
        },
      });
      const server = await startDevServer(worktree);
      // No test script: the proof fails closed straight away, and still tears down.
      const { record } = await proveTask(repo, id, {
        ...by,
        publish: async () => null,
      });
      expect(record.passed).toBe(false);
      expect(alive(server.pid)).toBe(false);
      expect(await ledgerOf(id)).toContain(
        `stopped the task's server on port ${server.port}`,
      );
    });
  },
);
