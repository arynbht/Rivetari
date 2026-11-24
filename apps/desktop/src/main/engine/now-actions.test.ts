import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  confirmTask,
  type JudgeRecord,
  loadTask,
  newTask,
  sha256,
  type TaskView,
} from "@arynbht/rivetari-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cardDigest } from "./now";
import {
  approveAssembly,
  type ConfirmDeps,
  confirmCard,
  judgeFindings,
  judgeView,
  openNowPr,
} from "./now-actions";
import { beatDeps } from "./task-beat";

// The Now view's actions against a real repo: confirm and approve go through
// the runtime's own calls (pull, lease, confirmTask or approveRoute, push),
// under git's user, and are refused when what was shown has changed.

const BY = "dev@example.com";
const CARD = {
  type: "feature" as const,
  description: "Readers can switch the theme.",
  acceptance: [{ id: "A1", text: "A toggle works", verify: "e2e" as const }],
};
const assemblyFor = (id: string) =>
  [
    `task: ${id}`,
    "sectors: [ui]",
    "phases: [build]",
    "skills: []",
    "budget: { skill_tokens: 0, context_tokens: 4000, steps: 30 }",
    "checks: [quality.lint.clean]",
    "proof: ui-screenshots",
    "review: { rubric: default, design_pass: true, security: false }",
    "stop_and_ask: [new_dependency]",
    "",
  ].join("\n");

let repo = "";
let config = "";
const saved = {
  key: process.env.RIVETARI_LEDGER_KEY,
  config: process.env.RIVETARI_CONFIG_DIR,
};
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const taskDir = (id: string) => join(repo, ".rivetari", "tasks", id);

async function routed(id: string): Promise<string> {
  await newTask(repo, { ...CARD, title: `Routed ${id}` }, { by: BY, id });
  await confirmTask(repo, id, { by: BY });
  const text = assemblyFor(id);
  await writeFile(join(taskDir(id), "assembly.yml"), text);
  const task = await loadTask(repo, id);
  await task.ledger.append({
    beat: "route",
    section: "timeline",
    text: `assembly proposed; sha256 ${sha256(text)}; skills none; proof ui-screenshots; awaiting approval`,
    by: `rivetari router (for ${BY})`,
  });
  return text;
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "rivetari-desktop-now-"));
  config = await mkdtemp(join(tmpdir(), "rivetari-desktop-config-"));
  process.env.RIVETARI_LEDGER_KEY = "cd".repeat(32);
  process.env.RIVETARI_CONFIG_DIR = config;
  git("init", "-q", "-b", "main");
  git("config", "user.email", BY);
  git("config", "user.name", "Dev");
  git("commit", "-q", "--allow-empty", "-m", "init");
});

afterEach(async () => {
  for (const [name, value] of [
    ["RIVETARI_LEDGER_KEY", saved.key],
    ["RIVETARI_CONFIG_DIR", saved.config],
  ] as const)
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  await rm(repo, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

describe("confirming a card from the Now view", () => {
  it("records the confirmation under git's user, takes the lease and pushes, as `rivetari task confirm` does", async () => {
    const task = await newTask(
      repo,
      { ...CARD, title: "Dark mode" },
      { by: BY, id: "T-0001" },
    );
    const result = await confirmCard(repo, {
      id: "T-0001",
      shown: cardDigest(task.card),
    });
    expect(result).toMatchObject({ id: "T-0001", by: BY, warning: null });
    expect(result.next).toMatch(/^route: /);

    const after = await loadTask(repo, "T-0001");
    expect(after.confirmed).toBe(true);
    expect(after.entries.at(-1)).toMatchObject({
      text: expect.stringMatching(/^intake confirmed; card sha256 /),
      by: BY,
    });
    expect(git("log", "--format=%s", "rivetari/tasks")).toContain(
      "T-0001: confirm done",
    );
    expect(git("show", "rivetari/tasks:T-0001/ledger.jsonl")).toContain(
      "intake confirmed",
    );
  });

  it("refuses a card that changed since it was shown, and confirms nothing", async () => {
    const task = await newTask(
      repo,
      { ...CARD, title: "Dark mode" },
      { by: BY, id: "T-0001" },
    );
    const shown = cardDigest(task.card);
    const path = join(taskDir("T-0001"), "card.yml");
    await writeFile(
      path,
      (await readFile(path, "utf8")).replace("Dark mode", "Light mode"),
    );
    const confirm = vi.fn();
    const deps: ConfirmDeps = {
      ...beatDeps,
      loadTask,
      confirmTask: confirm as unknown as ConfirmDeps["confirmTask"],
    };
    await expect(
      confirmCard(repo, { id: "T-0001", shown }, deps),
    ).rejects.toThrow(
      "T-0001's card changed since it was shown; read it again before confirming",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect((await loadTask(repo, "T-0001")).confirmed).toBe(false);
  });
});

describe("approving a route from the Now view", () => {
  it("seals the assembly the person read, as `rivetari task approve` does", async () => {
    const text = await routed("T-0001");
    const result = await approveAssembly(repo, {
      id: "T-0001",
      shown: sha256(text),
    });
    expect(result).toMatchObject({ id: "T-0001", by: BY, warning: null });
    expect(result.next).toMatch(/^isolate: /);
    const after = await loadTask(repo, "T-0001");
    expect(after.approved).toBe(true);
    expect(after.entries.at(-1)).toMatchObject({
      text: `route approved; assembly sha256 ${sha256(text)}`,
      by: BY,
    });
    expect(git("log", "--format=%s", "rivetari/tasks")).toContain(
      "T-0001: approve done",
    );
  });

  it("refuses an assembly that changed since it was shown", async () => {
    const text = await routed("T-0001");
    await writeFile(
      join(taskDir("T-0001"), "assembly.yml"),
      text.replace("steps: 30", "steps: 90"),
    );
    await expect(
      approveAssembly(repo, { id: "T-0001", shown: sha256(text) }),
    ).rejects.toThrow(
      "assembly.yml changed while it was being approved; review it again",
    );
    expect((await loadTask(repo, "T-0001")).approved).toBe(false);
  });
});

const RECORD: JudgeRecord = {
  task: "T-0001",
  round: 2,
  verdict: "needs a human",
  head: "0123456789ab",
  base: "main",
  tier1: {
    verdict: "needs-human",
    checks: [],
    protected: [
      {
        reason: "lint-config",
        path: "eslint.config.js",
        detail: "lint config changed",
      },
    ],
    notes: ["a protected path changed"],
  },
  review: {
    verdict: "blocking",
    body: "",
    model: "m",
    blocking: [
      {
        kind: "defect",
        file: "src/a.ts",
        line: 3,
        title: "Null deref",
        detail: "x can be null",
      },
    ],
    suggestions: [{ kind: "suggestion", line: null, title: "Rename y" }],
    acceptance: [
      { id: "A1", status: "met" },
      { id: "A2", status: "unmet", note: "no test" },
    ],
    unreviewed: [],
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  },
} as unknown as JudgeRecord;

describe("a judge that wants a person", () => {
  it("shows the blocking findings, unmet criteria and protected paths of its round", () => {
    expect(judgeView(RECORD)).toEqual({
      round: 2,
      verdict: "needs a human",
      blocking: [
        {
          kind: "defect",
          title: "Null deref",
          file: "src/a.ts",
          line: 3,
          detail: "x can be null",
        },
      ],
      suggestions: [
        {
          kind: "suggestion",
          title: "Rename y",
          file: null,
          line: null,
          detail: null,
        },
      ],
      acceptance: [{ id: "A2", status: "unmet", note: "no test" }],
      protectedPaths: ["eslint.config.js: lint config changed"],
      notes: ["a protected path changed"],
    });
    expect(judgeView(null)).toBeNull();
  });

  it("reads the round from this machine's record, and says plainly when it can't", async () => {
    const loadJudgeRecord = vi.fn(async () => RECORD);
    const task = { card: { id: "T-0001" } };
    const loadTask = vi.fn(async () => task);
    const deps = {
      loadTask: loadTask as never,
      loadJudgeRecord: loadJudgeRecord as never,
    };
    await expect(judgeFindings(repo, "T-0001", deps)).resolves.toMatchObject({
      round: 2,
    });
    expect(loadTask).toHaveBeenCalledWith(repo, "T-0001", { readOnly: true });
    expect(loadJudgeRecord).toHaveBeenCalledWith(repo, task);

    await expect(judgeFindings(repo, "T-0009")).rejects.toThrow(
      expect.objectContaining({
        name: "Error",
        message: expect.stringMatching(/no task T-0009/),
      }),
    );
  });
});

describe("opening a PR from the queue", () => {
  it("opens the https URL the hub's view of the task records", async () => {
    const views = [
      {
        id: "T-0001",
        problems: [],
        pr: { number: 7, url: "https://github.com/o/r/pull/7" },
      },
      { id: "T-0002", problems: [], pr: null },
    ] as unknown as TaskView[];
    const open = vi.fn(async () => undefined);
    await expect(openNowPr(views, "T-0001", open)).resolves.toEqual({
      url: "https://github.com/o/r/pull/7",
    });
    await expect(openNowPr(views, "T-0002", open)).rejects.toThrow(
      "has no PR yet",
    );
    await expect(openNowPr(views, "T-0003", open)).rejects.toThrow(
      "isn't one of the tasks on show",
    );
    expect(open).toHaveBeenCalledTimes(1);
  });
});
