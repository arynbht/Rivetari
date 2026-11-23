import type { TaskView } from "@arynbht/rivetari-runtime";
import { describe, expect, it } from "vitest";

import { TaskSummary } from "../../shared/ipc";
import { taskSummary } from "./tasks";

const entry = (seq: number) => ({
  seq,
  at: "2026-11-20T10:00:00.000Z",
  beat: "build" as const,
  section: "timeline" as const,
  text: `entry ${seq}`,
  by: "ann@example.com",
  prev: "genesis",
  mac: "00",
});

const view: TaskView = {
  id: "T-0001",
  title: "Running task",
  type: "feature",
  risk: "medium",
  owner: "ann@example.com",
  beat: "build",
  next: "build: plan and build in the worktree",
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
  entries: [entry(1), entry(2), entry(3)],
  progress: {
    beat: "build",
    startedAt: "2026-11-20T10:00:00.000Z",
    lastActivityAt: "2026-11-20T10:12:00.000Z",
    turns: 18,
    tokens: 52_000,
    lastTool: "Edit",
    pid: 4242,
  },
};

describe("the task list the Tasks tab is sent", () => {
  it("leaves each ledger out, says where it ends, and carries the running beat", () => {
    const summary = TaskSummary.parse(taskSummary(view));
    expect(summary).not.toHaveProperty("entries");
    expect(summary.ledgerSeq).toBe(3);
    expect(summary.progress).toEqual({
      beat: "build",
      startedAt: "2026-11-20T10:00:00.000Z",
      lastActivityAt: "2026-11-20T10:12:00.000Z",
      turns: 18,
      tokens: 52_000,
      lastTool: "Edit",
    });
  });

  it("an idle task with no ledger yet", () => {
    const summary = TaskSummary.parse(
      taskSummary({ ...view, entries: [], progress: undefined }),
    );
    expect(summary).toMatchObject({ ledgerSeq: 0, progress: null });
  });
});
