// The build commits whatever the worktree holds that HEAD doesn't, before it
// reads the agent's reply: a round that ends on a question keeps its work, and
// work a round left uncommitted goes in on the next one instead of reading as
// no change.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
import {
  confirmTask,
  loadTask,
  newTask,
  nextStep,
  openStops,
} from "../task/tasks.js";
import { type AgentCall, answerStops, buildTask } from "./build.js";
import { isolateTask } from "./isolate.js";

const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
let repo: string;
let context: RouteContext;
const by = { by: "dev@example.com", now: new Date("2026-11-24T16:00:00Z") };

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
  repo = await tmp("rivetari-build-commit-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "AGENTS.md"), "# Contract\n");
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
  for (const d of made) {
    await simpleGit(d)
      .raw(["worktree", "prune"])
      .catch(() => undefined);
    await rm(d, { recursive: true, force: true });
  }
  made.length = 0;
});

/** An approved, isolated task, and its worktree. */
async function isolatedTask(): Promise<{ id: string; worktree: string }> {
  const draft = await newTask(
    repo,
    {
      title: "Fix the total query",
      type: "fix",
      description: "total should sum the order lines.",
      acceptance: [{ id: "A1", text: "total sums lines", verify: "unit" }],
      touches: ["src/total.ts"],
      risk: "medium",
    },
    by,
  );
  const id = draft.card.id;
  await confirmTask(repo, id, by);
  await routeTask(repo, id, { ...by, context });
  await approveRoute(repo, id, { ...by, context });
  const { isolation } = await isolateTask(repo, id, { ...by, base: "main" });
  return { id, worktree: isolation.worktree };
}

/** An agent that plans one step, then runs `edit` and replies `text`. */
function agentThat(
  edit: (cwd: string) => Promise<void>,
  text: string,
): (call: AgentCall) => Promise<string> {
  return async (call) => {
    if (call.mode === "plan") return JSON.stringify({ steps: ["Sum it"] });
    await edit(call.cwd);
    return text;
  };
}

const sumLines = (cwd: string) =>
  writeFile(
    join(cwd, "src/total.ts"),
    "export const total = (l: number[]) => l.reduce((a, b) => a + b, 0);\n",
  );

const head = async (worktree: string) =>
  (await simpleGit(worktree).revparse(["HEAD"])).trim();
const dirty = async (worktree: string) =>
  (await simpleGit(worktree).raw(["status", "--porcelain"])).trim();

describe("build commits the round's work", () => {
  it("commits what the agent wrote before pausing on its question", async () => {
    const { id, worktree } = await isolatedTask();
    const before = await head(worktree);
    const outcome = await buildTask(repo, id, {
      ...by,
      agent: agentThat(async (cwd) => {
        await sumLines(cwd);
        await writeFile(join(cwd, "src/total.test.ts"), "// a new test\n");
      }, "Summed the lines.\nRIVETARI_STOP: Should blank lines count as zero?"),
    });

    expect(outcome.stops).toEqual([
      {
        trigger: "agent_question",
        detail: "Should blank lines count as zero?",
      },
    ]);
    const after = await head(worktree);
    expect(after).not.toBe(before);
    expect(outcome.commit).toBe(after);
    expect(await dirty(worktree)).toBe("");
    const files = await simpleGit(worktree).raw([
      "diff",
      "--name-only",
      before,
      after,
    ]);
    expect(files.split("\n").filter(Boolean).sort()).toEqual([
      "src/total.test.ts",
      "src/total.ts",
    ]);
    const ledger = await readFile(outcome.task.ledger.mdPath, "utf8");
    expect(ledger).toContain(
      `build paused: 1 thing(s) to ask about · commit ${after.slice(0, 12)}`,
    );
    expect(nextStep(outcome.task)).toMatch(/^stop-and-ask: /);
  });

  it("commits work an earlier round left uncommitted, instead of stopping on no_change", async () => {
    const { id, worktree } = await isolatedTask();
    const before = await head(worktree);
    // What a round that paused before its commit left behind.
    await sumLines(worktree);
    await writeFile(
      join(worktree, "src/lines.ts"),
      "export const lines = 1;\n",
    );
    const outcome = await buildTask(repo, id, {
      ...by,
      agent: agentThat(async () => undefined, "Nothing left to change."),
    });

    expect(outcome.stops).toEqual([]);
    const after = await head(worktree);
    expect(after).not.toBe(before);
    expect(await dirty(worktree)).toBe("");
    const ledger = await readFile(outcome.task.ledger.mdPath, "utf8");
    expect(ledger).not.toContain("no_change");
    expect(ledger).toContain(
      `build done · commit ${after.slice(0, 12)} · 2 file(s) this round`,
    );
    expect(nextStep(outcome.task)).toBe("prove");
  });

  it("recovers after an answered question whose work went uncommitted", async () => {
    const { id, worktree } = await isolatedTask();
    const before = await head(worktree);
    // The first round asked; its work sits uncommitted, as the old build left it.
    const first = await buildTask(repo, id, {
      ...by,
      agent: agentThat(async () => undefined, "RIVETARI_STOP: Sum or average?"),
    });
    expect(first.stops.map((s) => s.trigger)).toEqual(["agent_question"]);
    await sumLines(worktree);
    await answerStops(repo, id, {
      allow: true,
      note: "sum",
      by: "dev@example.com",
    });

    const second = await buildTask(repo, id, {
      ...by,
      agent: agentThat(async () => undefined, "Already done."),
    });
    expect(second.stops).toEqual([]);
    expect(await head(worktree)).not.toBe(before);
    expect(await dirty(worktree)).toBe("");
  });

  it("still stops on no_change when the worktree matches HEAD", async () => {
    const { id, worktree } = await isolatedTask();
    const before = await head(worktree);
    const outcome = await buildTask(repo, id, {
      ...by,
      agent: agentThat(async () => undefined, "I changed nothing."),
    });
    expect(outcome.stops).toEqual([
      { trigger: "no_change", detail: "I changed nothing." },
    ]);
    expect(await head(worktree)).toBe(before);
  });

  it("raises a question pause's other stops too, from the committed diff", async () => {
    const { id, worktree } = await isolatedTask();
    const outcome = await buildTask(repo, id, {
      ...by,
      agent: agentThat(async (cwd) => {
        await writeFile(
          join(cwd, "package.json"),
          `${JSON.stringify({ name: "demo", dependencies: { zod: "^4.0.0", "left-pad": "^1.3.0" } }, null, 2)}\n`,
        );
      }, "RIVETARI_STOP: Is left-pad acceptable here?"),
    });
    expect(outcome.stops).toEqual([
      { trigger: "agent_question", detail: "Is left-pad acceptable here?" },
      {
        trigger: "new_dependency",
        detail: "package.json adds left-pad@^1.3.0",
      },
    ]);
    expect(outcome.commit).toBe(await head(worktree));
    expect(openStops(await loadTask(repo, id))).toEqual([
      "agent_question: Is left-pad acceptable here?",
      "new_dependency: package.json adds left-pad@^1.3.0",
    ]);
  });
});

describe("the agent's question", () => {
  it("is recorded and shown in full, however long", async () => {
    const { id } = await isolatedTask();
    const question = `Which rounding should total() use? ${"The ledger rounds to cents, the invoice to whole units, and the export keeps four places. ".repeat(8)}Pick one.`;
    expect(question.length).toBeGreaterThan(500);
    const outcome = await buildTask(repo, id, {
      ...by,
      agent: agentThat(sumLines, `RIVETARI_STOP: ${question}`),
    });
    expect(outcome.stops).toEqual([
      { trigger: "agent_question", detail: question.trim() },
    ]);
    // `rivetari task resume` prints ledger.md; `task status` and the
    // desktop's needs-you read the open stops.
    const ledger = await readFile(outcome.task.ledger.mdPath, "utf8");
    expect(ledger).toContain(`asked: agent_question: ${question.trim()}`);
    expect(openStops(outcome.task)).toEqual([
      `agent_question: ${question.trim()}`,
    ]);
  });
});
