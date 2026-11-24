import type {
  LedgerEntry,
  TaskEvent,
  TaskView,
  TaskWatcher,
  watchTasks,
} from "@arynbht/rivetari-runtime";
import { describe, expect, it, vi } from "vitest";

import { NowHub } from "./now";

// The hub tells the Project view when a task in a repo closes as merged, so
// the profile is checked again after the change most likely to move it. A
// merge from before the app started is caught up on, never told.

const START = Date.parse("2026-11-24T09:00:00.000Z");

const entry = (
  seq: number,
  beat: LedgerEntry["beat"],
  section: LedgerEntry["section"],
  text: string,
  at: string,
): LedgerEntry => ({
  seq,
  at,
  beat,
  section,
  text,
  by: "ann@example.com",
  prev: "x",
  mac: "y",
});

const shipped = (id: string, at: string): TaskView => ({
  id,
  title: `Task ${id}`,
  type: "feature",
  risk: "medium",
  owner: "ann@example.com",
  beat: "ship",
  next: "close",
  done: false,
  source: "local",
  lease: null,
  buildRounds: 1,
  judgeRounds: 1,
  tokens: 0,
  costUsd: 0,
  pr: { number: 7, url: "https://github.com/o/r/pull/7" },
  needsYou: null,
  problems: [],
  entries: [entry(1, "ship", "timeline", "draft PR #7 opened", at)],
});

const closed = (view: TaskView, outcome: string, at: string): TaskView => ({
  ...view,
  beat: "close",
  done: true,
  entries: [
    ...view.entries,
    entry(2, "close", "outcome", outcome, at),
    entry(3, "close", "timeline", "ledger sealed", at),
  ],
});

function fakeWatch() {
  const watchers: {
    emit: (event: TaskEvent) => void;
    read: () => void;
  }[] = [];
  const watch = ((_repo, onEvent, options = {}) => {
    watchers.push({ emit: onEvent, read: () => options.onRead?.() });
    return {
      ready: new Promise<TaskView[]>(() => undefined),
      stop: vi.fn(async () => undefined),
    } satisfies TaskWatcher;
  }) as typeof watchTasks;
  return { watch, watchers };
}

function setup() {
  const { watch, watchers } = fakeWatch();
  const onMerged = vi.fn();
  const hub = new NowHub({
    watch,
    onNew: vi.fn(),
    onState: vi.fn(),
    onBadges: vi.fn(),
    onMerged,
    now: () => START,
  });
  return { hub, watchers, onMerged };
}

const changed = (task: TaskView): TaskEvent => ({
  kind: "changed",
  task,
  newEntries: [],
  previousBeat: "ship",
  closed: task.done,
});

describe("the hub's merges", () => {
  it("tells of a task that merges while the app runs, once, and not of earlier ones", async () => {
    const { hub, watchers, onMerged } = setup();
    await hub.setRepos(["/a"]);
    const w = watchers[0]!;
    const before = closed(
      shipped("T-0001", "2026-11-20T10:00:00.000Z"),
      "PR #3 merged by ann@example.com 2026-11-20 11:00",
      "2026-11-20T11:00:00.000Z",
    );
    const open = shipped("T-0002", "2026-11-24T08:00:00.000Z");
    w.emit({ kind: "snapshot", tasks: [before, open] });
    w.read();
    expect(onMerged).not.toHaveBeenCalled();

    const merged = closed(
      open,
      "PR #7 merged by ann@example.com 2026-11-24 09:30",
      "2026-11-24T09:30:00.000Z",
    );
    w.emit(changed(merged));
    expect(onMerged).toHaveBeenCalledTimes(1);
    expect(onMerged).toHaveBeenCalledWith("/a", "T-0002");

    // The same close read again isn't a second merge.
    w.emit(changed(merged));
    expect(onMerged).toHaveBeenCalledTimes(1);
  });

  it("doesn't count a task closed without merging", async () => {
    const { hub, watchers, onMerged } = setup();
    await hub.setRepos(["/a"]);
    const w = watchers[0]!;
    const open = shipped("T-0003", "2026-11-24T08:00:00.000Z");
    w.emit({ kind: "snapshot", tasks: [open] });
    w.read();
    w.emit(
      changed(
        closed(
          open,
          "abandoned by ann@example.com: not needed",
          "2026-11-24T09:30:00.000Z",
        ),
      ),
    );
    expect(onMerged).not.toHaveBeenCalled();
  });

  it("catches up on a merge the branch read brings in from before the app started", async () => {
    const { hub, watchers, onMerged } = setup();
    await hub.setRepos(["/a"]);
    const w = watchers[0]!;
    w.emit({ kind: "snapshot", tasks: [] });
    // Merged on another machine last week; the branch read adds it now.
    w.emit({
      kind: "added",
      task: closed(
        shipped("T-0004", "2026-11-17T10:00:00.000Z"),
        "PR #5 merged by bo@example.com 2026-11-17 11:00",
        "2026-11-17T11:00:00.000Z",
      ),
    });
    expect(onMerged).not.toHaveBeenCalled();
  });
});
