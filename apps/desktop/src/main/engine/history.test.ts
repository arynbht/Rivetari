import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { closeTask, loadTask, newTask } from "@arynbht/rivetari-runtime";

import { openHistoryPr, readHistory } from "./history";

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
  const dir = await tmp("rivetari-history-adapter-");
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  git("init", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  await writeFile(join(dir, "README.md"), "demo\n");
  git("add", "-A");
  git("commit", "-m", "base", "--no-verify");
  return dir;
}

describe("readHistory", { timeout: 60_000 }, () => {
  it("combines closed tasks, task metrics, findings and cost flags, skipping posture snapshots", async () => {
    const dir = await repo();
    const draft = await newTask(
      dir,
      {
        title: "Expensive low-risk change",
        type: "fix",
        description: "Fix something minor.",
        acceptance: [{ id: "A1", text: "works", verify: "unit" }],
        risk: "low",
      },
      { by: by.by, now: new Date("2026-11-23T09:00:00Z") },
    );
    const task = await loadTask(dir, draft.card.id);
    await task.ledger.append({
      beat: "build",
      section: "timeline",
      text: "build done · commit abcdef123456 · 2 file(s) this round · 5000 tokens · $1.25",
      by: "rivetari runtime",
      at: new Date("2026-11-23T09:10:00Z"),
    });
    await task.ledger.append({
      beat: "ship",
      section: "timeline",
      text: "draft PR opened: #7 https://github.com/o/r/pull/7 · rivetari/T-0001 at abcdef123456 → main",
      by: "rivetari runtime",
      at: new Date("2026-11-23T09:20:00Z"),
    });
    await closeTask(dir, draft.card.id, {
      by: by.by,
      now: new Date("2026-11-23T09:30:00Z"),
      pr: 7,
      prState: async () => ({
        state: "closed",
        merged: true,
        mergedBy: by.by,
        mergedAt: "2026-11-23T09:28:00Z",
      }),
    });
    const prevHistory = await readFile(
      join(dir, ".rivetari", "history.jsonl"),
      "utf8",
    );
    await writeFile(
      join(dir, ".rivetari", "history.jsonl"),
      `${JSON.stringify({
        date: "2026-11-22",
        score: 0.75,
        byLane: { hygiene: { pass: 3, total: 4 } },
      })}\n${prevHistory}`,
      "utf8",
    );

    const view = await readHistory(dir);
    expect(view.repoPath).toBe(dir);
    expect(view.problems).toEqual([]);
    expect(view.summary.tasks).toBe(1);
    expect(view.summary.merged).toBe(1);
    expect(view.summary.spend.totalUsd).toBe(1.25);
    expect(view.costFlags).toEqual([
      { task: draft.card.id, costUsd: 1.25, promptTokens: null },
    ]);
    expect(view.tasks[0]).toMatchObject({
      id: draft.card.id,
      title: "Expensive low-risk change",
      pr: 7,
      costUsd: 1.25,
    });
  });

  it("still shows the tasks when the judge's findings can't be counted", async () => {
    const view = await readHistory("/repo", {
      historyRows: async () => [
        {
          kind: "task",
          date: "2026-11-22",
          task: "T-0001",
          outcome: "merged",
          pr: 3,
          cost_usd: 0.5,
          tokens: 100,
          build_rounds: 1,
          judge_rounds: 1,
          minutes: 10,
          risk: "low",
          skills: [],
        } as never,
      ],
      closedTasks: async (_repo, rows) =>
        (rows ?? []).map((r) => ({
          id: r.task,
          title: null,
          outcome: r.outcome,
          pr: r.pr,
          costUsd: r.cost_usd,
          tokens: r.tokens,
          buildRounds: r.build_rounds,
          judgeRounds: r.judge_rounds,
          retryRounds: null,
          minutes: r.minutes,
          risk: r.risk ?? null,
          skills: r.skills,
          closedAt: r.date,
          cardToPrMinutes: null,
          judgeCostUsd: null,
          ledgerProblem: "no ledger",
        })),
      findingsMetrics: async () => {
        throw new Error("the catalog won't load");
      },
    });
    expect(view.tasks.map((t) => t.id)).toEqual(["T-0001"]);
    expect(view.summary.spend.totalUsd).toBe(0.5);
    expect(view.findings.reviewed).toBe(0);
    expect(view.findings.candidates).toEqual([]);
    expect(view.problems).toEqual([
      "The judge's findings can't be counted: the catalog won't load",
    ]);
  });
});

describe("openHistoryPr", () => {
  it("opens only https PR URLs from verified ledgers", async () => {
    const opened: string[] = [];
    const res = await openHistoryPr(
      "/tmp/repo",
      "T-0001",
      async (url) => {
        opened.push(url);
      },
      async () =>
        ({
          problems: [],
          entries: [
            {
              beat: "ship",
              section: "timeline",
              text: "draft PR opened: #9 https://github.com/o/r/pull/9 · rivetari/T-0001",
            },
          ],
        }) as never,
    );
    expect(res).toEqual({ url: "https://github.com/o/r/pull/9" });
    expect(opened).toEqual(["https://github.com/o/r/pull/9"]);

    await expect(
      openHistoryPr(
        "/tmp/repo",
        "T-0002",
        async () => undefined,
        async () =>
          ({
            problems: ["bad seal"],
            entries: [],
          }) as never,
      ),
    ).rejects.toThrow(/fails verification/);

    await expect(
      openHistoryPr(
        "/tmp/repo",
        "T-0003",
        async () => undefined,
        async () =>
          ({
            problems: [],
            entries: [
              {
                beat: "ship",
                section: "timeline",
                text: "draft PR opened: #9 javascript:alert(1) · b",
              },
            ],
          }) as never,
      ),
    ).rejects.toThrow(/isn't https/);
  });
});
