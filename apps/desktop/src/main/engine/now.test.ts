import type {
  LedgerEntry,
  TaskEvent,
  TaskView,
  TaskWatcher,
  watchTasks,
} from "@arynbht/rivetari-runtime";
import { describe, expect, it, vi } from "vitest";

import { NowState } from "../../shared/ipc";
import {
  cardDigest,
  needsYouItems,
  NowHub,
  nowState,
  recentEvents,
  recentKind,
  routeReasons,
  runningTasks,
} from "./now";

// The Now view's reading of the watcher's task views: the queue, what's
// running, the feed, and the hub that keeps every sidebar repo watched and
// says when something new needs a person.

const AT = "2026-11-20T10:00:00.000Z";
let seq = 0;
const entry = (
  beat: LedgerEntry["beat"],
  section: LedgerEntry["section"],
  text: string,
  at = AT,
): LedgerEntry => ({
  seq: ++seq,
  at,
  beat,
  section,
  text,
  by: "ann@example.com",
  prev: "x",
  mac: "y",
});

const CARD = {
  id: "T-0001",
  title: "Dark mode",
  type: "feature" as const,
  source: "prompt",
  description: "Readers can switch the theme.",
  acceptance: [{ id: "A1", text: "A toggle works", verify: "e2e" as const }],
  out_of_scope: ["print styles"],
  touches: ["src/theme/**"],
  pages: [],
  constraints: [],
  risk: "medium" as const,
  owner: "ann@example.com",
  created: "2026-11-20",
};

const ASSEMBLY = [
  "task: T-0002",
  "sectors: [ui]",
  "phases: [build]",
  "skills: []",
  "budget: { skill_tokens: 0, context_tokens: 4000, steps: 30 }",
  "checks: [quality.lint.clean]",
  "proof: ui-screenshots",
  "review: { rubric: default, design_pass: true, security: false }",
  "stop_and_ask: [new_dependency, { touches: [db/**] }]",
  "gaps: [no vendored skill covers motion]",
  "",
].join("\n");

const view = (id: string, over: Partial<TaskView> = {}): TaskView => ({
  id,
  title: `Task ${id}`,
  type: "feature",
  risk: "medium",
  owner: "ann@example.com",
  beat: "build",
  next: "build",
  done: false,
  source: "local",
  lease: null,
  buildRounds: 0,
  judgeRounds: 0,
  tokens: 0,
  costUsd: 0,
  pr: null,
  needsYou: null,
  problems: [],
  entries: [entry("intake", "timeline", "card drafted")],
  ...over,
});

describe("the Needs-you queue", () => {
  it("has one item per kind of wait, from the runtime's own needsYou and next", () => {
    const pr = { number: 42, url: "https://github.com/o/r/pull/42" };
    const items = needsYouItems([
      view("T-0001", {
        beat: "intake",
        next: "intake: review the card and confirm it",
        needsYou: {
          kind: "intake",
          why: "the card is waiting to be confirmed",
        },
        card: CARD,
      }),
      view("T-0002", {
        beat: "route",
        needsYou: {
          kind: "route",
          why: "the proposed route is waiting for approval",
        },
        assemblyText: ASSEMBLY,
        entries: [
          entry("route", "decision", "routed to ui: ui (path src/ui)"),
          entry("route", "timeline", "assembly proposed; sha256 abc"),
        ],
      }),
      view("T-0003", {
        needsYou: { kind: "stop", why: "dependency: adds left-pad" },
      }),
      view("T-0004", {
        beat: "judge",
        pr,
        needsYou: { kind: "judge", why: "protected path changed" },
      }),
      view("T-0005", {
        beat: "ship",
        pr,
        next: "close: once the PR is merged",
      }),
      view("T-0006", {
        needsYou: { kind: "record", why: "the record fails verification" },
      }),
      // Nothing waits on these: one building, one closed with its PR.
      view("T-0007"),
      view("T-0008", { beat: "close", done: true, pr }),
    ]);

    expect(items.map((i) => [i.id, i.kind])).toEqual([
      ["T-0001", "intake"],
      ["T-0002", "route"],
      ["T-0003", "stop"],
      ["T-0004", "judge"],
      ["T-0005", "merge"],
      ["T-0006", "record"],
    ]);
    const [intake, route, , judge, merge] = items;
    expect(intake).toMatchObject({
      next: "intake: review the card and confirm it",
      card: {
        description: "Readers can switch the theme.",
        acceptance: [{ id: "A1", text: "A toggle works", verify: "e2e" }],
        outOfScope: ["print styles"],
        touches: ["src/theme/**"],
      },
      shown: cardDigest(CARD),
    });
    expect(route).toMatchObject({
      assembly: {
        sectors: ["ui"],
        gaps: ["no vendored skill covers motion"],
        checks: ["quality.lint.clean"],
        proof: "ui-screenshots",
        budget: { skillTokens: 0, contextTokens: 4000, steps: 30 },
        stopAndAsk: ["new_dependency", "touches db/**"],
        review: { designPass: true, security: false },
      },
      problems: [],
      reasons: ["routed to ui: ui (path src/ui)"],
    });
    expect(route?.kind === "route" && route.shown).toMatch(/^[0-9a-f]{64}$/);
    expect(judge?.pr).toEqual(pr);
    expect(merge).toMatchObject({
      pr,
      next: "close: once the PR is merged",
      why: "shipped as PR #42; it waits for a person to merge it",
    });
  });

  it("says why an assembly can't be shown, and still offers the route", () => {
    const [item] = needsYouItems([
      view("T-0001", {
        needsYou: { kind: "route", why: "waiting" },
        assemblyText: "sectors: [nowhere]\n",
      }),
    ]);
    expect(item).toMatchObject({ kind: "route", assembly: null });
    expect(item?.kind === "route" && item.problems.length).toBeGreaterThan(0);
  });

  it("reads the router's reasons from the decisions written just before the latest proposal", () => {
    expect(
      routeReasons([
        entry("route", "decision", "old reason"),
        entry("route", "timeline", "assembly proposed; sha256 1"),
        entry("route", "decision", "routed to api"),
        entry("route", "decision", "no vendored skill covers api"),
        entry("route", "timeline", "assembly proposed; sha256 2"),
      ]),
    ).toEqual(["routed to api", "no vendored skill covers api"]);
    expect(routeReasons([entry("intake", "timeline", "drafted")])).toEqual([]);
  });
});

describe("what's running", () => {
  it("lists build, prove, judge and ship beats with live progress, and nothing else", () => {
    const progress = {
      startedAt: AT,
      lastActivityAt: AT,
      turns: 18,
      lastTool: "Edit",
    };
    const running = runningTasks([
      view("T-0001", {
        costUsd: 0.12,
        progress: { ...progress, beat: "build" },
      }),
      view("T-0002", { progress: { ...progress, beat: "route" } }),
      view("T-0003", { progress: null }),
      view("T-0004", { done: true, progress: { ...progress, beat: "ship" } }),
      view("T-0005", {
        progress: { beat: "judge", startedAt: AT, lastActivityAt: AT },
      }),
    ]);
    expect(running).toEqual([
      {
        id: "T-0001",
        title: "Task T-0001",
        beat: "build",
        startedAt: AT,
        lastActivityAt: AT,
        turns: 18,
        lastTool: "Edit",
        costUsd: 0.12,
      },
      {
        id: "T-0005",
        title: "Task T-0005",
        beat: "judge",
        startedAt: AT,
        lastActivityAt: AT,
        costUsd: 0,
      },
    ]);
  });
});

describe("the Recent feed", () => {
  it("knows which ledger entries are events", () => {
    const kind = (
      b: LedgerEntry["beat"],
      s: LedgerEntry["section"],
      t: string,
    ) => recentKind(entry(b, s, t));
    expect(kind("close", "outcome", "PR #4 merged by ann · 2h")).toBe("merged");
    expect(kind("close", "outcome", "PR #4 closed without merging")).toBe(
      "closed",
    );
    expect(kind("close", "outcome", "abandoned: not needed")).toBe("abandoned");
    expect(
      kind("judge", "timeline", "judge passed · round 1 · head 0123456789ab"),
    ).toBe("judged");
    expect(kind("build", "stop", "asked: dependency: adds x")).toBe("stopped");
    expect(kind("judge", "stop", "answered: allowed — fine")).toBe("answered");
    expect(kind("ship", "timeline", "draft PR opened: #4 https://x")).toBe(
      "shipped",
    );
    expect(kind("build", "timeline", "build started")).toBeNull();
    expect(kind("build", "stop", "flagged: something")).toBeNull();
  });

  it("is newest first across tasks, and keeps the last fifty", () => {
    const a = view("T-0001", {
      entries: [
        entry("build", "stop", "asked: q1", "2026-11-20T10:00:00.000Z"),
        entry("build", "stop", "answered: allowed", "2026-11-20T12:00:00.000Z"),
      ],
    });
    const b = view("T-0002", {
      entries: [
        entry(
          "ship",
          "timeline",
          "draft PR opened: #9 https://x",
          "2026-11-20T11:00:00.000Z",
        ),
      ],
    });
    expect(recentEvents([a, b]).map((e) => [e.id, e.kind])).toEqual([
      ["T-0001", "answered"],
      ["T-0002", "shipped"],
      ["T-0001", "stopped"],
    ]);
    const many = view("T-0003", {
      entries: Array.from({ length: 60 }, (_, i) =>
        entry(
          "build",
          "stop",
          `asked: q${i}`,
          `2026-11-21T10:${String(i).padStart(2, "0")}:00.000Z`,
        ),
      ),
    });
    const feed = recentEvents([many]);
    expect(feed).toHaveLength(50);
    expect(feed[0]?.text).toBe("asked: q59");
  });
});

describe("a repo's Now state", () => {
  it("is what the IPC contract carries, with the open tasks' cost", () => {
    const state = nowState(
      "/repo",
      [
        view("T-0001", { costUsd: 0.5 }),
        view("T-0002", { costUsd: 2, done: true }),
      ],
      true,
      null,
    );
    expect(NowState.parse(state)).toEqual(state);
    expect(state).toMatchObject({
      taskCount: 2,
      openCostUsd: 0.5,
      ready: true,
    });
  });
});

/** A watch stand-in: each call is a watcher the test drives by hand. */
function fakeWatch() {
  const watchers: {
    repo: string;
    intervalMs: number | undefined;
    localFirst: boolean | undefined;
    emit: (event: TaskEvent) => void;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const watch = ((repo, onEvent, options = {}) => {
    const stop = vi.fn(async () => undefined);
    watchers.push({
      repo,
      intervalMs: options.intervalMs,
      localFirst: options.localFirst,
      emit: onEvent,
      stop,
    });
    return {
      ready: new Promise<TaskView[]>(() => undefined),
      stop,
    } satisfies TaskWatcher;
  }) as typeof watchTasks;
  return { watch, watchers };
}

const stopped = (id: string, why: string, at: string) =>
  view(id, {
    needsYou: { kind: "stop", why },
    entries: [entry("build", "stop", `asked: ${why}`, at)],
  });

describe("the hub", () => {
  const START = Date.parse("2026-11-24T09:00:00.000Z");
  const setup = () => {
    const { watch, watchers } = fakeWatch();
    const onNew = vi.fn();
    const onState = vi.fn();
    const onBadges = vi.fn();
    const hub = new NowHub({
      watch,
      onNew,
      onState,
      onBadges,
      now: () => START,
      intervals: { shown: 100, others: 1000 },
    });
    return { hub, watchers, onNew, onState, onBadges };
  };

  it("doesn't tell of what was waiting at the first read, then tells of each new item once", async () => {
    const { hub, watchers, onNew, onState } = setup();
    await hub.setRepos(["/a"]);
    const w = watchers[0]!;
    expect(w.localFirst).toBe(true);

    const old = stopped(
      "T-0001",
      "dependency: adds x",
      "2026-11-20T10:00:00.000Z",
    );
    w.emit({ kind: "snapshot", tasks: [old] });
    expect(onNew).not.toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith(
      expect.objectContaining({ repoPath: "/a", ready: true }),
    );
    expect(hub.state("/a").needsYou).toHaveLength(1);

    // The branch read brings in a task that has waited since before launch.
    w.emit({
      kind: "added",
      task: stopped(
        "T-0002",
        "schema: adds a column",
        "2026-11-21T10:00:00.000Z",
      ),
    });
    expect(onNew).not.toHaveBeenCalled();

    // A stop asked after the hub started is news, told once.
    const fresh = stopped(
      "T-0003",
      "dependency: adds y",
      "2026-11-24T09:05:00.000Z",
    );
    w.emit({ kind: "added", task: fresh });
    w.emit({
      kind: "changed",
      task: fresh,
      newEntries: [],
      previousBeat: "build",
      closed: false,
    });
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledWith(
      "/a",
      expect.objectContaining({ id: "T-0003", kind: "stop" }),
    );
  });

  it("keeps per-repo badge counts, reads the repo on show more often, and stops repos taken off the sidebar", async () => {
    const { hub, watchers, onBadges } = setup();
    await hub.setRepos(["/a", "/b"]);
    expect(watchers.map((w) => [w.repo, w.intervalMs])).toEqual([
      ["/a", 1000],
      ["/b", 1000],
    ]);
    watchers[0]!.emit({
      kind: "snapshot",
      tasks: [stopped("T-0001", "q", AT), view("T-0002")],
    });
    expect(hub.badges()).toEqual([
      { repoPath: "/a", count: 1 },
      { repoPath: "/b", count: 0 },
    ]);
    expect(onBadges).toHaveBeenLastCalledWith([
      { repoPath: "/a", count: 1 },
      { repoPath: "/b", count: 0 },
    ]);

    await hub.select("/b");
    const restarted = watchers[2]!;
    expect([
      restarted.repo,
      restarted.intervalMs,
      restarted.localFirst,
    ]).toEqual(["/b", 100, false]);
    expect(watchers[1]!.stop).toHaveBeenCalled();
    // A replaced watcher's late events are ignored.
    watchers[1]!.emit({
      kind: "snapshot",
      tasks: [stopped("T-0009", "late", AT)],
    });
    expect(hub.state("/b").needsYou).toEqual([]);

    await hub.setRepos(["/b"]);
    expect(watchers[0]!.stop).toHaveBeenCalled();
    expect(hub.state("/a")).toMatchObject({ ready: false, taskCount: 0 });
    expect(hub.views("/b")).toEqual([]);

    await hub.stop();
    expect(restarted.stop).toHaveBeenCalled();
  });
});
