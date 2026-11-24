import type { TaskHistoryRow, TaskView } from "@arynbht/rivetari-runtime";
import { describe, expect, it, vi } from "vitest";

import { NowCi, NowHealth } from "../../shared/ipc";
import {
  type CheckRun,
  type CiDeps,
  ciSummary,
  type HealthDeps,
  mainCi,
  nowHealth,
} from "./now-health";

// The health strip: each part read from the record that answers it, each
// failing on its own, and main's CI read only for a person signed in.

const row = (date: string, cost: number): TaskHistoryRow => ({
  kind: "task",
  date,
  task: `T-${date}`,
  type: "feature",
  outcome: "merged",
  pr: 1,
  sectors: [],
  skills: [],
  minutes: 1,
  tokens: 1,
  cost_usd: cost,
  build_rounds: 1,
  judge_rounds: 1,
});

const view = (over: Partial<TaskView>): TaskView =>
  ({
    id: "T-0001",
    done: false,
    costUsd: 0,
    entries: [],
    ...over,
  }) as TaskView;

const gapped = (gap: string) =>
  [
    "task: T-0001",
    "sectors: [ui]",
    "phases: [build]",
    "skills: []",
    "budget: { skill_tokens: 0, context_tokens: 4000, steps: 30 }",
    "checks: [quality.lint.clean]",
    "proof: ui-screenshots",
    "review: { rubric: default, design_pass: true, security: false }",
    "stop_and_ask: []",
    `gaps: [${gap}]`,
    "",
  ].join("\n");

const deps = (over: Partial<HealthDeps> = {}): HealthDeps => ({
  loadProfile: vi.fn(async () => ({ autonomy: "review-at-pr" })) as never,
  historyRows: vi.fn(async () => [
    row("2026-11-24", 1.5),
    row("2026-11-24", 0.25),
    row("2026-11-19", 2),
    row("2026-11-17", 9),
  ]),
  readLock: vi.fn(async () => ({
    version: 1 as const,
    skills: [{}, {}, {}] as never,
  })),
  readState: vi.fn(async () => ({
    syncedAt: "x",
    lock: "y",
    skills: [{ installed: true }, { installed: true }, { installed: false }],
    blocked: [],
  })) as never,
  skillsStatus: vi.fn(async () => ["web-design is not installed"]),
  now: () => new Date("2026-11-24T15:00:00.000Z"),
  ...over,
});

describe("the health strip", () => {
  it("reads autonomy from the profile, spend from history and the open tasks, and skills from the lock", async () => {
    const health = await nowHealth(
      "/repo",
      [
        view({ id: "T-0001", costUsd: 0.4, assemblyText: gapped("motion") }),
        view({ id: "T-0002", costUsd: 0.1, assemblyText: gapped("motion") }),
        view({
          id: "T-0003",
          costUsd: 5,
          done: true,
          assemblyText: gapped("legal"),
        }),
      ],
      deps(),
    );
    expect(NowHealth.parse(health)).toEqual(health);
    expect(health.autonomy).toEqual({
      configured: "review-at-pr",
      error: null,
    });
    expect(health.spend).toEqual({
      todayUsd: 1.75,
      // The last seven UTC days, today included: the 17th is out.
      weekUsd: 3.75,
      openUsd: 0.5,
      error: null,
    });
    expect(health.skills).toEqual({
      locked: 3,
      installed: 2,
      problems: ["web-design is not installed"],
      gaps: ["motion"],
      error: null,
    });
  });

  it("keeps the other parts when one can't be read", async () => {
    const health = await nowHealth(
      "/repo",
      [view({ costUsd: 0.2 })],
      deps({
        loadProfile: vi.fn(async () => {
          throw new Error("profile.yml is invalid");
        }),
        historyRows: vi.fn(async () => {
          throw new Error("history.jsonl is unreadable");
        }),
        readLock: vi.fn(async () => {
          throw new Error("skills.lock is invalid");
        }),
      }),
    );
    expect(health.autonomy).toEqual({
      configured: null,
      error: "profile.yml is invalid",
    });
    expect(health.spend).toMatchObject({
      openUsd: 0.2,
      error: "history.jsonl is unreadable",
    });
    expect(health.skills).toMatchObject({ error: "skills.lock is invalid" });
  });

  it("says a repo with no profile has no configured level", async () => {
    const health = await nowHealth(
      "/repo",
      [],
      deps({ loadProfile: vi.fn(async () => null) }),
    );
    expect(health.autonomy.configured).toBeNull();
  });
});

const run = (status: string, conclusion: string | null): CheckRun => ({
  status,
  conclusion,
  head_sha: "0123456789abcdef",
});
const URL = "https://github.com/o/r/commits/main";

describe("main's CI", () => {
  it("is said in one line from the default branch's check runs", () => {
    expect(ciSummary([], "main", URL)).toMatchObject({
      state: "none",
      detail: "no checks ran on main's latest commit",
    });
    expect(
      ciSummary(
        [run("completed", "success"), run("completed", "skipped")],
        "main",
        URL,
      ),
    ).toMatchObject({
      state: "passing",
      detail: "2 checks passed on main at 0123456",
    });
    expect(
      ciSummary(
        [run("completed", "success"), run("in_progress", null)],
        "main",
        URL,
      ),
    ).toMatchObject({
      state: "running",
      detail: "1 of 2 checks still running on main at 0123456",
    });
    expect(
      ciSummary(
        [
          run("completed", "failure"),
          run("in_progress", null),
          run("completed", "timed_out"),
        ],
        "main",
        URL,
      ),
    ).toMatchObject({
      state: "failing",
      detail: "2 of 3 checks failed on main at 0123456",
    });
  });

  it("is read only when signed in, through githubToken with the app's token", async () => {
    const client = {
      defaultBranch: vi.fn(async () => "main"),
      checkRuns: vi.fn(async () => [run("completed", "success")]),
    };
    const ciDeps: CiDeps = {
      resolveRepoSlug: vi.fn(async () => ({ owner: "o", repo: "r" })),
      githubToken: vi.fn(async (_repo: string, explicit?: string) =>
        explicit ? { token: explicit, source: "explicit" as const } : null,
      ),
      client: vi.fn(() => client),
    };

    const out = await mainCi("/repo", null, ciDeps);
    expect(out).toEqual({
      state: "signed-out",
      branch: null,
      url: null,
      detail: "sign in to see CI",
    });
    expect(ciDeps.resolveRepoSlug).not.toHaveBeenCalled();

    const passing = await mainCi("/repo", "app-token", ciDeps);
    expect(NowCi.parse(passing)).toEqual({
      state: "passing",
      branch: "main",
      url: URL,
      detail: "1 check passed on main at 0123456",
    });
    expect(ciDeps.githubToken).toHaveBeenCalledWith("/repo", "app-token");
    expect(ciDeps.client).toHaveBeenCalledWith("app-token");
    expect(client.checkRuns).toHaveBeenCalledWith("o", "r", "main");
  });

  it("says why when there's no GitHub origin or GitHub can't be read", async () => {
    const noOrigin: CiDeps = {
      resolveRepoSlug: vi.fn(async () => null),
      githubToken: vi.fn(),
      client: vi.fn(),
    };
    expect(await mainCi("/repo", "t", noOrigin)).toMatchObject({
      state: "unavailable",
      detail: "this repo has no GitHub origin to read CI from",
    });

    const offline: CiDeps = {
      resolveRepoSlug: vi.fn(async () => ({ owner: "o", repo: "r" })),
      githubToken: vi.fn(async () => ({
        token: "t",
        source: "explicit" as const,
      })),
      client: () => ({
        defaultBranch: async () => {
          throw new Error("fetch failed");
        },
        checkRuns: async () => [],
      }),
    };
    expect(await mainCi("/repo", "t", offline)).toMatchObject({
      state: "unavailable",
      detail: "CI couldn't be read: fetch failed",
    });
  });
});
