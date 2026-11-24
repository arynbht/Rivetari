import type {
  LedgerEntry,
  TaskEvent,
  TaskView,
  TaskWatcher,
  watchTasks,
} from "@arynbht/rivetari-runtime";
import { describe, expect, it, vi } from "vitest";

import { TaskSummary } from "../../shared/ipc";
import { itemKey, needsYouItems, NowHub } from "./now";
import { taskSummary } from "./tasks";

// The hub as the Tasks tab uses it: one watcher per repo for the Now view and
// the tab together, a new item judged by its task's ledger seq rather than by
// another machine's clock, and an item that leaves Needs you told as gone.

const entry = (
  seq: number,
  text: string,
  at = "2026-11-20T10:00:00.000Z",
  section: LedgerEntry["section"] = "stop",
): LedgerEntry => ({
  seq,
  at,
  beat: "build",
  section,
  text,
  by: "ann@example.com",
  prev: "x",
  mac: "y",
});

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
  entries: [entry(1, "card drafted", undefined, "timeline")],
  ...over,
});

/** A watch stand-in: each call is a watcher the test drives by hand. */
function fakeWatch() {
  const watchers: {
    repo: string;
    intervalMs: number | undefined;
    emit: (event: TaskEvent) => void;
    /** The watcher's first full read (the branch merged in) has landed. */
    read: () => void;
    stop: ReturnType<typeof vi.fn>;
  }[] = [];
  const watch = ((repo, onEvent, options = {}) => {
    const stop = vi.fn(async () => undefined);
    watchers.push({
      repo,
      intervalMs: options.intervalMs,
      emit: onEvent,
      read: () => options.onRead?.(),
      stop,
    });
    return {
      ready: new Promise<TaskView[]>(() => undefined),
      stop,
    } satisfies TaskWatcher;
  }) as typeof watchTasks;
  return { watch, watchers };
}

const START = Date.parse("2026-11-24T09:00:00.000Z");
const setup = () => {
  const { watch, watchers } = fakeWatch();
  const onNew = vi.fn();
  const onGone = vi.fn();
  const hub = new NowHub({
    watch,
    onNew,
    onGone,
    onState: vi.fn(),
    onBadges: vi.fn(),
    now: () => START,
    intervals: { shown: 100, others: 1000 },
  });
  return { hub, watchers, onNew, onGone };
};

describe("the Tasks tab on the hub", () => {
  it("shares the sidebar repo's watcher, read as often as the repo on show, and resolves on its first read", async () => {
    const { hub, watchers } = setup();
    await hub.setRepos(["/a", "/b"]);
    const onChange = vi.fn();
    const watching = hub.watchTab("/b", onChange);
    // /b is read more often now: its watcher is restarted at the shown interval.
    await vi.waitFor(() => expect(watchers).toHaveLength(3));
    expect([watchers[2]?.repo, watchers[2]?.intervalMs]).toEqual(["/b", 100]);
    expect(watchers[1]?.stop).toHaveBeenCalled();

    watchers[2]!.emit({ kind: "snapshot", tasks: [view("T-0001")] });
    const first = await watching;
    expect(first.views.map((v) => v.id)).toEqual(["T-0001"]);
    expect(onChange).toHaveBeenLastCalledWith(
      [expect.objectContaining({ id: "T-0001" })],
      null,
    );
    expect(hub.tabViews("/b")?.map((v) => v.id)).toEqual(["T-0001"]);
    expect(hub.tabViews("/a")).toBeUndefined();

    // A change to another repo isn't the tab's.
    onChange.mockClear();
    watchers[0]!.emit({ kind: "snapshot", tasks: [view("T-0009")] });
    expect(onChange).not.toHaveBeenCalled();

    await hub.unwatchTab();
    expect(hub.tabViews("/b")).toBeUndefined();
    // Still in the sidebar, so still watched, at the others' pace again.
    expect(watchers.at(-1)).toMatchObject({ repo: "/b", intervalMs: 1000 });
    expect(hub.views("/b").map((v) => v.id)).toEqual(["T-0001"]);
  });

  it("watches a repo only the tab shows, with no badge or notice, and drops it when the tab goes", async () => {
    const { hub, watchers, onNew } = setup();
    const watching = hub.watchTab("/solo", vi.fn());
    expect(watchers).toHaveLength(1);
    expect(watchers[0]).toMatchObject({ repo: "/solo", intervalMs: 100 });
    watchers[0]!.emit({ kind: "error", message: "busy" });
    watchers[0]!.emit({ kind: "snapshot", tasks: [] });
    await expect(watching).resolves.toEqual({ views: [], error: null });
    watchers[0]!.read();
    watchers[0]!.emit({
      kind: "added",
      task: view("T-0001", {
        needsYou: { kind: "stop", why: "q" },
        entries: [entry(1, "asked: q", "2026-11-25T00:00:00.000Z")],
      }),
    });
    expect(onNew).not.toHaveBeenCalled();
    expect(hub.badges()).toEqual([]);
    await hub.unwatchTab();
    expect(watchers[0]!.stop).toHaveBeenCalled();
    expect(hub.views("/solo")).toEqual([]);
  });

  it("doesn't leave a watch waiting when its repo stops being watched before the first read", async () => {
    const { hub, watchers } = setup();
    const watching = hub.watchTab("/slow", vi.fn());
    // The tab moves on to another repo before /slow's first read lands.
    void hub.watchTab("/other", vi.fn());
    await expect(watching).resolves.toEqual({ views: [], error: null });
    expect(watchers[0]).toMatchObject({ repo: "/slow" });
    expect(watchers[0]!.stop).toHaveBeenCalled();
    await hub.stop();
  });
});

describe("what the hub tells as new, and as gone", () => {
  const stop = (id: string, seq: number, why: string, at?: string) =>
    view(id, {
      needsYou: { kind: "stop", why },
      entries: [
        entry(1, "card drafted", undefined, "timeline"),
        entry(seq, `asked: ${why}`, at),
      ],
    });

  it("doesn't tell the branch catching up with a local-first list as news, however far ahead its seq", async () => {
    const { hub, watchers, onNew } = setup();
    await hub.setRepos(["/a"]);
    const w = watchers[0]!;
    // This machine's copy of T-0001 ends at seq 1.
    w.emit({ kind: "snapshot", tasks: [view("T-0001")] });
    // The branch read brings in seq 7: a stop asked on another machine last week.
    w.emit({
      kind: "changed",
      task: stop(
        "T-0001",
        7,
        "schema: adds a column",
        "2026-11-17T10:00:00.000Z",
      ),
      newEntries: [],
      previousBeat: "build",
      closed: false,
    });
    w.read();
    expect(onNew).not.toHaveBeenCalled();

    // Caught up: the next question, at seq 8, is news.
    w.emit({
      kind: "changed",
      task: stop("T-0001", 8, "dependency: adds y", "2026-11-17T11:00:00.000Z"),
      newEntries: [],
      previousBeat: "build",
      closed: false,
    });
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledWith(
      "/a",
      expect.objectContaining({ id: "T-0001", why: "dependency: adds y" }),
    );
  });

  it("goes by the task's own ledger seq, not the entry's clock, once caught up", async () => {
    const { hub, watchers, onNew } = setup();
    await hub.setRepos(["/a"]);
    const w = watchers[0]!;
    w.emit({ kind: "snapshot", tasks: [view("T-0001"), view("T-0002")] });
    w.read();

    // Another machine's clock is days behind, but the ledger moved on: news.
    w.emit({
      kind: "changed",
      task: stop(
        "T-0001",
        2,
        "schema: adds a column",
        "2026-11-01T00:00:00.000Z",
      ),
      newEntries: [],
      previousBeat: "build",
      closed: false,
    });
    expect(onNew).toHaveBeenCalledWith(
      "/a",
      expect.objectContaining({ id: "T-0001", kind: "stop" }),
    );

    // A clock days ahead with no new entry since the first read: not news.
    onNew.mockClear();
    w.emit({
      kind: "changed",
      task: view("T-0002", {
        needsYou: { kind: "stop", why: "dependency: adds x" },
        entries: [
          entry(1, "asked: dependency: adds x", "2026-12-30T00:00:00.000Z"),
        ],
      }),
      newEntries: [],
      previousBeat: "build",
      closed: false,
    });
    expect(onNew).not.toHaveBeenCalled();
  });

  it("tells an item that left Needs you as gone, and every item of a repo taken off the sidebar", async () => {
    const { hub, watchers, onGone } = setup();
    await hub.setRepos(["/a", "/b"]);
    const waiting = stop("T-0001", 2, "dependency: adds x");
    watchers[0]!.emit({ kind: "snapshot", tasks: [waiting] });
    const key = itemKey(needsYouItems([waiting])[0]!);

    watchers[0]!.emit({
      kind: "changed",
      task: view("T-0001"),
      newEntries: [],
      previousBeat: "build",
      closed: false,
    });
    expect(onGone).toHaveBeenCalledWith("/a", key);

    const other = stop("T-0005", 3, "schema: adds y");
    watchers[1]!.emit({ kind: "snapshot", tasks: [other] });
    onGone.mockClear();
    await hub.setRepos(["/a"]);
    expect(onGone).toHaveBeenCalledWith(
      "/b",
      itemKey(needsYouItems([other])[0]!),
    );
  });
});

describe("the list the Tasks tab is sent", () => {
  it("says what each task waits on, a shipped PR waiting to merge included", () => {
    const shipped = view("T-0003", {
      beat: "ship",
      pr: { number: 42, url: "https://github.com/o/r/pull/42" },
    });
    expect(TaskSummary.parse(taskSummary(shipped)).waiting).toBe("merge");
    expect(
      taskSummary(view("T-0004", { needsYou: { kind: "route", why: "r" } }))
        .waiting,
    ).toBe("route");
    expect(taskSummary(view("T-0005")).waiting).toBeNull();
    expect(taskSummary({ ...shipped, done: true }).waiting).toBeNull();
  });
});
