import type { TaskView } from "@arynbht/rivetari-runtime";
import { describe, expect, it } from "vitest";

import { applyTaskEvent } from "./tasks";

const task = (id: string, beat: TaskView["beat"] = "build"): TaskView => ({
  id,
  title: `Task ${id}`,
  type: "feature",
  risk: "medium",
  owner: "ann@example.com",
  beat,
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
  entries: [],
});

describe("the tasks list the Tasks tab is sent", () => {
  it("follows the watcher's events, in id order, and keeps it through a read error", () => {
    let tasks = applyTaskEvent([], {
      kind: "snapshot",
      tasks: [task("T-0001"), task("T-0010")],
    });
    tasks = applyTaskEvent(tasks, { kind: "added", task: task("T-0002") });
    expect(tasks.map((t) => t.id)).toEqual(["T-0001", "T-0002", "T-0010"]);

    tasks = applyTaskEvent(tasks, {
      kind: "changed",
      task: task("T-0002", "judge"),
      newEntries: [],
      previousBeat: "build",
      closed: false,
    });
    expect(tasks.find((t) => t.id === "T-0002")?.beat).toBe("judge");

    tasks = applyTaskEvent(tasks, { kind: "error", message: "busy" });
    tasks = applyTaskEvent(tasks, { kind: "removed", id: "T-0001" });
    expect(tasks.map((t) => t.id)).toEqual(["T-0002", "T-0010"]);
  });
});
