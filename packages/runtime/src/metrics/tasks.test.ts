import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeTask } from "../ship/close.js";
import type { Task } from "../task/tasks.js";
import { loadTask, newTask } from "../task/tasks.js";
import {
  type ClosedTask,
  closedTasks,
  judgeUsage,
  taskMetrics,
} from "./tasks.js";

const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-23T10:00:00Z") };

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repo(): Promise<string> {
  const dir = await tmp("rivetari-metrics-tasks-");
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await writeFile(join(dir, "README.md"), "demo\n");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  return dir;
}

function makeClosedTask(overrides: Partial<ClosedTask> = {}): ClosedTask {
  return {
    id: "T-0001",
    title: "Fix metrics",
    outcome: "merged",
    pr: 10,
    costUsd: 1.5,
    tokens: 3000,
    buildRounds: 1,
    judgeRounds: 1,
    retryRounds: 0,
    minutes: 20,
    risk: "low",
    skills: ["diff"],
    closedAt: "2026-11-23T12:00:00.000Z",
    cardToPrMinutes: 12.5,
    judgeCostUsd: 0.4,
    ledgerProblem: null,
    ...overrides,
  };
}

describe("judgeUsage", () => {
  it("adds up the judge's usage notes alone, leaving the agent's and quoted ones out", () => {
    const task = {
      entries: [
        {
          beat: "intake",
          section: "card",
          text: "card drafted · 100 tokens · $0.10",
        },
        {
          beat: "build",
          section: "timeline",
          text: "build started · skills spine · 3 repo file(s) in context · 1000 tokens · $0.25",
        },
        {
          beat: "build",
          section: "timeline",
          text: "build done · commit abc1234 · 2 file(s) this round · 500 tokens · $0.15\nquoted · 9999 tokens · $9.99",
        },
        {
          beat: "judge",
          section: "verdict",
          text: "review round 1: passed; 0 blocking (0 suggestions) · 800 tokens · $0.35",
        },
      ],
    } as unknown as Task;

    const judge = judgeUsage(task);
    expect(judge.tokens).toBe(800);
    expect(judge.costUsd).toBeCloseTo(0.35, 5);
  });
});

describe("closedTasks", { timeout: 60_000 }, () => {
  it("joins history rows with read-only task ledgers and reports missing or unverified ones", async () => {
    const dir = await repo();
    const d1 = await newTask(
      dir,
      {
        title: "First fix",
        type: "fix",
        description: "Fix first issue.",
        acceptance: [{ id: "A1", text: "passes", verify: "unit" }],
        risk: "low",
      },
      { by: by.by, now: new Date("2026-11-23T09:00:00Z") },
    );
    const t1 = await loadTask(dir, d1.card.id);
    await t1.ledger.append({
      beat: "build",
      section: "timeline",
      text: "build done · commit abcdef123456 · 1 file(s) this round · 1000 tokens · $0.45",
      by: "rivetari runtime",
      at: new Date("2026-11-23T09:10:00Z"),
    });
    await t1.ledger.append({
      beat: "judge",
      section: "verdict",
      text: "review round 1: passed; 0 blocking (0 suggestions) · 500 tokens · $0.20",
      by: "rivetari runtime",
      at: new Date("2026-11-23T09:15:00Z"),
    });
    await t1.ledger.append({
      beat: "ship",
      section: "timeline",
      text: "draft PR opened: #41 https://github.com/o/r/pull/41 · rivetari/T-0001 at 0123456789ab → main",
      by: "rivetari runtime",
      at: new Date("2026-11-23T09:30:00Z"),
    });
    await closeTask(dir, d1.card.id, {
      by: by.by,
      now: new Date("2026-11-23T10:00:00Z"),
      pr: 41,
      prState: async () => ({
        state: "closed",
        merged: true,
        mergedBy: by.by,
        mergedAt: "2026-11-23T09:55:00Z",
      }),
    });

    const d2 = await newTask(
      dir,
      {
        title: "Tampered ledger task",
        type: "fix",
        description: "Second issue.",
        acceptance: [{ id: "A1", text: "passes", verify: "unit" }],
        risk: "medium",
      },
      { by: by.by, now: new Date("2026-11-23T11:00:00Z") },
    );
    await closeTask(dir, d2.card.id, {
      by: by.by,
      now: new Date("2026-11-24T11:30:00Z"),
      abandon: "superseded",
    });

    const ledgerMdPath = join(
      dir,
      ".rivetari",
      "tasks",
      d2.card.id,
      "ledger.md",
    );
    const handEdited = `${await readFile(ledgerMdPath, "utf8")}\nhand edit\n`;
    await writeFile(ledgerMdPath, handEdited, "utf8");
    const ledgerJsonlPath = join(
      dir,
      ".rivetari",
      "tasks",
      d2.card.id,
      "ledger.jsonl",
    );
    const jsonl = await readFile(ledgerJsonlPath, "utf8");
    await writeFile(ledgerJsonlPath, `${jsonl}{"bad":true}\n`, "utf8");

    const missingRow = {
      kind: "task" as const,
      date: "2026-11-22",
      task: "T-0099",
      outcome: "closed" as const,
      pr: 99,
      cost_usd: 0.75,
      tokens: 1200,
      build_rounds: 2,
      judge_rounds: 1,
      minutes: 15,
      risk: "low" as const,
      skills: [],
      rounds: [{ n: 1 }, { n: 2, retry: true }],
    };

    const existing = await closedTasks(dir);
    const list = await closedTasks(dir, [
      missingRow,
      ...existing.map((e) => ({
        kind: "task" as const,
        date: e.closedAt.slice(0, 10),
        task: e.id,
        outcome: e.outcome,
        pr: e.pr,
        cost_usd: e.costUsd,
        tokens: e.tokens,
        build_rounds: e.buildRounds,
        judge_rounds: e.judgeRounds,
        minutes: e.minutes,
        risk: (e.risk ?? undefined) as "low" | "medium" | undefined,
        skills: e.skills,
        ...(e.retryRounds !== null ? { rounds: [{ n: 1 }] } : {}),
      })),
    ]);

    expect(await readFile(ledgerMdPath, "utf8")).toBe(handEdited);
    expect(list.map((t) => t.id)).toEqual([d2.card.id, d1.card.id, "T-0099"]);

    const first = list.find((t) => t.id === d1.card.id);
    expect(first).toMatchObject({
      title: "First fix",
      outcome: "merged",
      pr: 41,
      costUsd: 0.65,
      judgeCostUsd: 0.2,
      cardToPrMinutes: 30,
      ledgerProblem: null,
    });

    const tampered = list.find((t) => t.id === d2.card.id);
    expect(tampered?.title).toBe("Tampered ledger task");
    expect(tampered?.ledgerProblem).toMatch(/doesn't verify/);
    expect(tampered?.judgeCostUsd).toBeNull();

    const missing = list.find((t) => t.id === "T-0099");
    expect(missing).toMatchObject({
      title: null,
      retryRounds: 1,
      judgeCostUsd: null,
    });
    expect(missing?.ledgerProblem).toBeTruthy();
  });
});

describe("taskMetrics", () => {
  it("returns zeros and nulls when there are no closed tasks", () => {
    expect(taskMetrics([])).toEqual({
      tasks: 0,
      merged: 0,
      abandoned: 0,
      closed: 0,
      spend: {
        totalUsd: 0,
        mergedUsd: 0,
        abandonedUsd: 0,
        closedUsd: 0,
        perMergedUsd: null,
        mergedMedianUsd: null,
        abandonedShare: null,
      },
      judge: { costUsd: 0, share: null, tasks: 0 },
      rounds: {
        build: 0,
        judge: 0,
        retries: 0,
        retryShare: null,
        multiBuild: 0,
      },
      cardToPr: { medianMinutes: null, tasks: 0 },
      trend: [],
    });
  });

  it("aggregates spend, judge share, retries, card-to-PR median and oldest-first daily trend", () => {
    const m = taskMetrics([
      makeClosedTask({
        id: "T-0001",
        outcome: "merged",
        costUsd: 1.0,
        judgeCostUsd: 0.2,
        buildRounds: 1,
        retryRounds: 0,
        cardToPrMinutes: 10,
        closedAt: "2026-11-22T10:00:00Z",
      }),
      makeClosedTask({
        id: "T-0002",
        outcome: "abandoned",
        costUsd: 2.0,
        judgeCostUsd: null,
        buildRounds: 3,
        judgeRounds: 2,
        retryRounds: 2,
        cardToPrMinutes: null,
        closedAt: "2026-11-22T15:00:00Z",
      }),
      makeClosedTask({
        id: "T-0003",
        outcome: "merged",
        costUsd: 3.0,
        judgeCostUsd: 0.8,
        buildRounds: 2,
        judgeRounds: 1,
        retryRounds: 1,
        cardToPrMinutes: 30,
        closedAt: "2026-11-23T09:00:00Z",
      }),
      makeClosedTask({
        id: "T-0004",
        outcome: "closed",
        costUsd: 0.5,
        judgeCostUsd: 0.1,
        buildRounds: 1,
        judgeRounds: 1,
        retryRounds: null,
        cardToPrMinutes: 20,
        closedAt: "2026-11-23T12:00:00Z",
      }),
    ]);

    expect(m.tasks).toBe(4);
    expect(m.merged).toBe(2);
    expect(m.abandoned).toBe(1);
    expect(m.closed).toBe(1);
    expect(m.spend).toEqual({
      totalUsd: 6.5,
      mergedUsd: 4,
      abandonedUsd: 2,
      closedUsd: 0.5,
      perMergedUsd: 3.25,
      mergedMedianUsd: 2,
      abandonedShare: 2 / 6.5,
    });
    expect(m.judge.costUsd).toBe(1.1);
    expect(m.judge.tasks).toBe(3);
    expect(m.judge.share).toBeCloseTo(1.1 / 4.5, 5);
    expect(m.rounds).toEqual({
      build: 7,
      judge: 5,
      retries: 3,
      retryShare: 3 / 6,
      multiBuild: 2,
    });
    expect(m.cardToPr).toEqual({ medianMinutes: 20, tasks: 3 });
    expect(m.trend).toEqual([
      {
        date: "2026-11-22",
        merged: 1,
        mergedUsd: 1,
        abandonedUsd: 2,
        closedUsd: 0,
      },
      {
        date: "2026-11-23",
        merged: 1,
        mergedUsd: 3,
        abandonedUsd: 0,
        closedUsd: 0.5,
      },
    ]);
  });
});
