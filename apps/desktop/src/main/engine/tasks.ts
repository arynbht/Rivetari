// Tasks adapter: the runtime's read-only task watcher, kept as a whole list so
// the renderer gets the repo's tasks in one piece after every change. One repo is
// watched at a time (the Tasks tab shows one); watching another, or closing the
// window, stops the last watcher. The watcher writes nothing; the two actions
// here are the person's own: answering a stop, which goes through the same
// runtime calls as `rivetari task answer` (task-beat.ts), and opening a task's PR.
// The Now view keeps watchers of its own (now.ts) for every repo in the sidebar.
// The list the renderer gets leaves each ledger out: a running task's progress
// changes every couple of seconds, and sending every task's whole ledger each
// time would be most of the payload. The open task's ledger is asked for alone.
// Electron-free except the push callback and the open function passed in.
import { resolve } from "node:path";

import {
  answerStops,
  nextStep,
  type TaskEvent,
  type TaskView,
  type TaskWatcher,
  watchTasks,
} from "@arynbht/rivetari-runtime";

import type {
  TaskAnswerRequest,
  TaskAnswerResult,
  TaskEntry,
  TasksState,
  TaskSummary,
} from "../../shared/ipc";
import { beatDeps, type BeatDeps, recordBeat } from "./task-beat";

/** The list after one watcher event; a read error leaves the list as it was. */
export function applyTaskEvent(
  tasks: TaskView[],
  event: TaskEvent,
): TaskView[] {
  switch (event.kind) {
    case "snapshot":
      return event.tasks;
    case "added":
      return [...tasks, event.task].sort(
        (a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)),
      );
    case "changed":
      return tasks.map((t) => (t.id === event.task.id ? event.task : t));
    case "removed":
      return tasks.filter((t) => t.id !== event.id);
    case "error":
      return tasks;
  }
}

/** A task as the tab lists it: no ledger, only where it ends. */
export function taskSummary(view: TaskView): TaskSummary {
  const { entries, progress, ...rest } = view;
  return {
    ...rest,
    ledgerSeq: entries.at(-1)?.seq ?? 0,
    progress: progress
      ? {
          beat: progress.beat,
          startedAt: progress.startedAt,
          lastActivityAt: progress.lastActivityAt,
          ...(progress.turns === undefined ? {} : { turns: progress.turns }),
          ...(progress.tokens === undefined ? {} : { tokens: progress.tokens }),
          ...(progress.lastTool === undefined
            ? {}
            : { lastTool: progress.lastTool }),
        }
      : null,
  };
}

let active: TaskWatcher | null = null;
/**
 * The tasks the tab was last sent, whole: opening a PR goes by the record, not
 * the renderer, and the open task's ledger comes from here.
 */
let shown: { repoPath: string; tasks: TaskView[] } | null = null;

/**
 * Watch `repoPath`'s tasks, replacing any earlier watch. Resolves with the first
 * state; every later change is handed to `onState`.
 */
export async function watchRepoTasks(
  repoPath: string,
  onState: (state: TasksState) => void,
  intervalMs?: number,
): Promise<TasksState> {
  let tasks: TaskView[] = [];
  let error: string | null = null;
  const state = (): TasksState => ({
    repoPath,
    tasks: tasks.map(taskSummary),
    error,
  });
  let settled = false;
  const watcher = watchTasks(
    repoPath,
    (event) => {
      tasks = applyTaskEvent(tasks, event);
      // An error stays on show until the next read that changes something.
      error = event.kind === "error" ? event.message : null;
      if (active === watcher) shown = { repoPath, tasks };
      // The first snapshot is the reply to the watch call itself.
      if (settled) onState(state());
    },
    // This machine's copies list at once; the branch's view follows as changes.
    { localFirst: true, ...(intervalMs === undefined ? {} : { intervalMs }) },
  );
  // Swap first, then stop the one replaced: two watch calls racing each other
  // can't both see no watcher and leave one running.
  const replaced = active;
  active = watcher;
  await replaced?.stop();
  try {
    tasks = await watcher.ready;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  settled = true;
  if (active === watcher) shown = { repoPath, tasks };
  return state();
}

/** Task `id`'s ledger as the watcher last read it, for the task the tab has open. */
export function taskLedger(repoPath: string, id: string): TaskEntry[] {
  const task =
    shown && resolve(shown.repoPath) === resolve(repoPath)
      ? shown.tasks.find((t) => t.id === id)
      : undefined;
  if (!task) throw new Error(`${id} isn't one of the tasks on show`);
  return task.entries;
}

export async function unwatchTasks(): Promise<void> {
  const watcher = active;
  active = null;
  shown = null;
  await watcher?.stop();
}

/** The runtime calls an answer makes; a test hands in its own. */
export interface AnswerDeps extends BeatDeps {
  answerStops: typeof answerStops;
}

const runtimeDeps: AnswerDeps = { ...beatDeps, answerStops };

/**
 * Allow or deny task `id`'s open stops, as `rivetari task answer` does, the
 * answer recorded under the person's own name (see recordBeat).
 */
export async function answerTask(
  repoPath: string,
  request: TaskAnswerRequest,
  deps: AnswerDeps = runtimeDeps,
): Promise<TaskAnswerResult> {
  const { id, allow } = request;
  const note = request.note.trim() || undefined;
  const { by, result, warning } = await recordBeat(
    repoPath,
    id,
    {
      beat: "answer",
      doing: "an answer to",
      noun: "the answer",
      run: (by) => deps.answerStops(repoPath, id, { allow, note, by }),
    },
    deps,
  );
  return {
    id,
    answer: allow ? "allowed" : "denied",
    by,
    next: nextStep(result),
    warning,
  };
}

/**
 * The https URL of task `id`'s PR, from its view as the watcher read it from
 * the ledger, never one the renderer sends, and only from a record that verifies.
 */
export function prUrlOf(task: TaskView | undefined, id: string): string {
  if (!task) throw new Error(`${id} isn't one of the tasks on show`);
  if (task.problems.length > 0)
    throw new Error(
      `${id}'s record fails verification; its PR link isn't opened`,
    );
  if (!task.pr) throw new Error(`${id} has no PR yet`);
  let url: URL;
  try {
    url = new URL(task.pr.url);
  } catch {
    throw new Error(`${id}'s PR link isn't a URL: ${task.pr.url}`);
  }
  if (url.protocol !== "https:")
    throw new Error(`${id}'s PR link isn't https: ${task.pr.url}`);
  return url.href;
}

/** Open task `id`'s PR with `open` (the OS browser); see prUrlOf. */
export async function openTaskPr(
  repoPath: string,
  id: string,
  open: (url: string) => Promise<void>,
): Promise<{ url: string }> {
  const url = prUrlOf(
    shown && resolve(shown.repoPath) === resolve(repoPath)
      ? shown.tasks.find((t) => t.id === id)
      : undefined,
    id,
  );
  await open(url);
  return { url };
}
