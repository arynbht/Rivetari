// Tasks adapter: the runtime's read-only task watcher, kept as a whole list so
// the renderer gets the repo's tasks in one piece after every change. One repo is
// watched at a time (the Tasks tab shows one); watching another, or closing the
// window, stops the last watcher. The watcher writes nothing; the two actions
// here are the person's own: answering a stop, which goes through the same
// runtime calls as `rivetari task answer`, and opening a task's PR.
// The list the renderer gets leaves each ledger out: a running task's progress
// changes every couple of seconds, and sending every task's whole ledger each
// time would be most of the payload. The open task's ledger is asked for alone.
// Electron-free except the push callback and the open function passed in.
import { resolve } from "node:path";

import {
  answerStops,
  commitTask,
  holderName,
  nextStep,
  pullTasks,
  type TaskEvent,
  type TaskView,
  type TaskWatcher,
  watchTasks,
  whoami,
} from "@arynbht/rivetari-runtime";

import type {
  TaskAnswerRequest,
  TaskAnswerResult,
  TaskEntry,
  TasksState,
  TaskSummary,
} from "../../shared/ipc";

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
export interface AnswerDeps {
  whoami: typeof whoami;
  pullTasks: typeof pullTasks;
  commitTask: typeof commitTask;
  answerStops: typeof answerStops;
}

const runtimeDeps: AnswerDeps = {
  whoami,
  pullTasks,
  commitTask,
  answerStops,
};

/** Answers being recorded now, by repo and task: a second click waits its turn. */
const answering = new Set<string>();

/** A plain Error, so the renderer shows the runtime's message without its class name. */
const plain = (err: unknown) =>
  new Error(err instanceof Error ? err.message : String(err));

/**
 * Allow or deny task `id`'s open stops, as `rivetari task answer` does: bring
 * the record up to the tasks branch, take the task's lease, append the answer
 * under the person's own name (git's user.email, as the CLI records it) and
 * push. A failed answer still pushes what it got through. When only the last
 * push fails, the answer is kept on this machine and the result says so, the
 * way the CLI warns; its next beat pushes it.
 */
export async function answerTask(
  repoPath: string,
  request: TaskAnswerRequest,
  deps: AnswerDeps = runtimeDeps,
): Promise<TaskAnswerResult> {
  const { id, allow } = request;
  const note = request.note.trim() || undefined;
  // Windows paths are case-insensitive: C:\Repo and c:\repo are one repo.
  const path = resolve(repoPath);
  const key = `${process.platform === "win32" ? path.toLowerCase() : path}#${id}`;
  if (answering.has(key))
    throw new Error(`an answer to ${id} is already being recorded`);
  answering.add(key);
  try {
    const by = await deps.whoami(repoPath);
    const holder = holderName(by);
    await deps.pullTasks(repoPath);
    await deps.commitTask(repoPath, id, { holder, message: `${id}: answer` });
    let next: string;
    try {
      next = nextStep(
        await deps.answerStops(repoPath, id, { allow, note, by }),
      );
    } catch (err) {
      // The answer's own error is the one to report; a failed push goes with it.
      const pushed = await deps
        .commitTask(repoPath, id, { holder, message: `${id}: answer failed` })
        .then(
          () => null,
          (pushErr: unknown) => plain(pushErr).message,
        );
      if (pushed === null) throw err;
      throw new Error(
        `${plain(err).message}; pushing what got through also failed: ${pushed}`,
      );
    }
    let warning: string | null = null;
    try {
      await deps.commitTask(repoPath, id, {
        holder,
        message: `${id}: answer done`,
      });
    } catch (err) {
      warning = `the answer is recorded, but pushing it failed: ${plain(err).message}. It's kept on this machine; the next beat on ${id} pushes it.`;
    }
    return {
      id,
      answer: allow ? "allowed" : "denied",
      by,
      next,
      warning,
    };
  } catch (err) {
    throw plain(err);
  } finally {
    answering.delete(key);
  }
}

/**
 * Open task `id`'s PR with `open` (the OS browser): the URL is the one the
 * watcher read from the task's ledger, never one the renderer sends, and only
 * an https one from a record that verifies.
 */
export async function openTaskPr(
  repoPath: string,
  id: string,
  open: (url: string) => Promise<void>,
): Promise<{ url: string }> {
  const task =
    shown && resolve(shown.repoPath) === resolve(repoPath)
      ? shown.tasks.find((t) => t.id === id)
      : undefined;
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
  await open(url.href);
  return { url: url.href };
}
