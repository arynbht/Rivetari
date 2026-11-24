import type { TaskHistoryRow, TaskView } from "@arynbht/rivetari-runtime";
import { describe, expect, it, vi } from "vitest";

import { HomeView, type NowState, type PostureLens } from "../../shared/ipc";
import { type HomeDeps, readHome } from "./home";
import { spendFrom } from "./now-health";

// Home reads one line per registered repo from the readers the per-repo views
// use: the Now hub for what's running and waiting, history.jsonl for spend,
// Posture's phase lens, and the profile's autonomy level. Each part fails on
// its own, and only the registered repos are read.

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

const state = (repoPath: string, over: Partial<NowState> = {}): NowState => ({
  repoPath,
  ready: true,
  taskCount: 0,
  running: [],
  needsYou: [],
  recent: [],
  openCostUsd: 0,
  error: null,
  ...over,
});

const lens = (over: Partial<PostureLens> = {}): PostureLens => ({
  declaredPhase: "build",
  inferredPhase: "discovery",
  allGreen: false,
  nextPhase: "design",
  phases: [],
  blockers: [
    { control: "a", title: "A", severity: "high", effort: "small" },
    { control: "b", title: "B", severity: "low", effort: "small" },
  ] as never,
  ...over,
});

const deps = (over: Partial<HomeDeps> = {}): HomeDeps => ({
  listRepos: async () => [
    { path: "/repos/alpha", name: "alpha" },
    { path: "/repos/beta", name: "beta" },
  ],
  state: (repoPath) =>
    repoPath === "/repos/alpha"
      ? state(repoPath, {
          running: [
            {
              id: "T-0003",
              title: "Add dark mode",
              beat: "build",
              startedAt: "2026-11-24T10:00:00.000Z",
              lastActivityAt: "2026-11-24T10:05:00.000Z",
              costUsd: 0.4,
            },
          ],
          needsYou: [
            {
              id: "T-0004",
              title: "Fix the header",
              kind: "stop",
              why: "adds a dependency",
              next: "answer it",
              pr: null,
              ledgerSeq: 7,
            },
          ],
        })
      : state(repoPath, { ready: false }),
  views: (repoPath) =>
    repoPath === "/repos/alpha"
      ? ([
          { id: "T-0003", done: false, costUsd: 0.4 },
          { id: "T-0001", done: true, costUsd: 3 },
        ] as TaskView[])
      : [],
  loadProfile: vi.fn(async (repoPath: string) =>
    repoPath === "/repos/alpha"
      ? { phase: "build", autonomy: "review-at-pr" }
      : null,
  ) as never,
  historyRows: vi.fn(async (repoPath: string) =>
    repoPath === "/repos/alpha"
      ? [row("2026-11-24", 1.5), row("2026-11-20", 0.5), row("2026-11-10", 9)]
      : [],
  ),
  readPhase: vi.fn(async (repoPath: string) =>
    repoPath === "/repos/alpha" ? lens() : null,
  ),
  now: () => new Date("2026-11-24T15:00:00.000Z"),
  ...over,
});

describe("Home", () => {
  it("reads each registered repo's running, waiting, spend, phase and autonomy", async () => {
    const view = await readHome(deps());
    expect(HomeView.parse(view)).toEqual(view);
    expect(view.repos.map((r) => r.name)).toEqual(["alpha", "beta"]);

    const [alpha, beta] = view.repos;
    expect(alpha).toMatchObject({
      repoPath: "/repos/alpha",
      ready: true,
      running: [{ id: "T-0003", beat: "build" }],
      needsYou: [
        {
          id: "T-0004",
          title: "Fix the header",
          kind: "stop",
          why: "adds a dependency",
        },
      ],
      // The 10th is outside the last seven days; only the open task counts as open.
      spend: { weekUsd: 2, openUsd: 0.4, error: null },
      autonomy: { configured: "review-at-pr", error: null },
      phase: {
        declared: "build",
        inferred: "discovery",
        allGreen: false,
        nextPhase: "design",
        blockers: 2,
      },
      phaseNote: null,
    });
    expect(beta).toMatchObject({
      ready: false,
      running: [],
      needsYou: [],
      spend: { weekUsd: 0, openUsd: 0, error: null },
      autonomy: { configured: null, error: null },
      phase: null,
      phaseNote: "no audit recorded yet: run rivetari audit",
    });
  });

  it("gives Posture the profile's declared phase", async () => {
    const readPhase = vi.fn(async () => lens());
    await readHome(deps({ readPhase }));
    expect(readPhase).toHaveBeenCalledWith("/repos/alpha", "build");
    expect(readPhase).toHaveBeenCalledWith("/repos/beta", null);
  });

  it("lets each part fail on its own and says why", async () => {
    const view = await readHome(
      deps({
        listRepos: async () => [{ path: "/repos/alpha", name: "alpha" }],
        loadProfile: vi.fn(async () => {
          throw new Error("profile.yml: bad yaml");
        }) as never,
        historyRows: vi.fn(async () => {
          throw new Error("history.jsonl unreadable");
        }),
        readPhase: vi.fn(async () => {
          throw new Error("Gate catalog is invalid: x");
        }),
      }),
    );
    const [alpha] = view.repos;
    expect(alpha!.running).toHaveLength(1);
    expect(alpha!.needsYou).toHaveLength(1);
    expect(alpha!.autonomy).toEqual({
      configured: null,
      error: "profile.yml: bad yaml",
    });
    expect(alpha!.spend).toEqual({
      weekUsd: 0,
      openUsd: 0.4,
      error: "history.jsonl unreadable",
    });
    expect(alpha!.phase).toBeNull();
    expect(alpha!.phaseNote).toBe(
      "the posture gate can't be read: Gate catalog is invalid: x",
    );
  });

  it("reads only the registered repos", async () => {
    const seen: string[] = [];
    await readHome(
      deps({
        listRepos: async () => [{ path: "/repos/only", name: "only" }],
        state: (repoPath) => {
          seen.push(repoPath);
          return state(repoPath);
        },
      }),
    );
    expect(seen).toEqual(["/repos/only"]);
  });

  it("has no repos to show when none are registered", async () => {
    expect(await readHome(deps({ listRepos: async () => [] }))).toEqual({
      repos: [],
    });
  });
});

describe("spendFrom", () => {
  it("adds up today, the last seven UTC days and the open tasks", () => {
    expect(
      spendFrom(
        [row("2026-11-24", 1), row("2026-11-18", 2), row("2026-11-17", 4)],
        [
          { done: false, costUsd: 0.25 } as TaskView,
          { done: true, costUsd: 8 } as TaskView,
        ],
        new Date("2026-11-24T23:59:00.000Z"),
      ),
    ).toEqual({ todayUsd: 1, weekUsd: 3, openUsd: 0.25 });
  });
});
