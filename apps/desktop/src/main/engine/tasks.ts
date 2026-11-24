// Tasks adapter: the Tasks tab's view of one repo's tasks, kept as a whole
// list so the renderer gets them in one piece after every change. The tasks
// come from the Now hub's watcher (now.ts), the same one the Now view and the
// badges read, so the repo on show is polled once; showing another repo, or
// closing the window, lets the hub drop a repo only the tab kept watched. The
// two actions here are the person's own: answering a stop, which goes through
// the same runtime calls as `rivetari task answer` (task-beat.ts), and opening
// a task's PR. The list the renderer gets leaves each ledger out: a running
// task's progress changes every couple of seconds, and sending every task's
// whole ledger each time would be most of the payload. The open task's ledger
// is asked for alone. Electron-free except the push callback and the open
// function passed in.
import {
  answerStops,
  nextStep,
  type TaskView,
  WATCH_INTERVAL_MS,
} from "@arynbht/rivetari-runtime";

import type {
  TaskAnswerRequest,
  TaskAnswerResult,
  TaskEntry,
  TasksState,
  TaskSummary,
} from "../../shared/ipc";
import { applyTaskEvent, needsYouItems, NowHub } from "./now";
import { beatDeps, type BeatDeps, recordBeat } from "./task-beat";

export { applyTaskEvent };

/** A task as the tab lists it: no ledger, only where it ends. */
export function taskSummary(view: TaskView): TaskSummary {
  const { entries, progress, ...rest } = view;
  return {
    ...rest,
    ledgerSeq: entries.at(-1)?.seq ?? 0,
    // What the Now view's queue would say it waits on, a PR to merge included.
    waiting: needsYouItems([view])[0]?.kind ?? null,
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

/** The hub the tab listens to: the app's own (shareHub), or one made on first use. */
let hub: NowHub | null = null;

/** Listen to the app's hub, which also feeds the Now view, rather than a second watcher. */
export function shareHub(shared: NowHub): void {
  hub = shared;
}

const hubFor = (intervalMs?: number): NowHub =>
  (hub ??= new NowHub({
    onState: () => undefined,
    onBadges: () => undefined,
    onNew: () => undefined,
    intervals: {
      shown: intervalMs ?? WATCH_INTERVAL_MS,
      others: intervalMs ?? WATCH_INTERVAL_MS,
    },
  }));

const stateOf = (
  repoPath: string,
  views: TaskView[],
  error: string | null,
): TasksState => ({ repoPath, tasks: views.map(taskSummary), error });

/**
 * Show `repoPath`'s tasks, replacing any repo shown before. Resolves with the
 * first state; every later change is handed to `onState`. `intervalMs` only
 * sets how often a hub made here reads (a test's), on the call that makes it;
 * after that, and with the app's hub (shareHub), the hub's own intervals hold.
 */
export async function watchRepoTasks(
  repoPath: string,
  onState: (state: TasksState) => void,
  intervalMs?: number,
): Promise<TasksState> {
  const { views, error } = await hubFor(intervalMs).watchTab(
    repoPath,
    (next, nextError) => onState(stateOf(repoPath, next, nextError)),
  );
  return stateOf(repoPath, views, error);
}

/** The tasks on show in the tab, whole, when it shows `repoPath`. */
const shownTasks = (repoPath: string): TaskView[] | undefined =>
  hub?.tabViews(repoPath);

/** Task `id`'s ledger as the watcher last read it, for the task the tab has open. */
export function taskLedger(repoPath: string, id: string): TaskEntry[] {
  const task = shownTasks(repoPath)?.find((t) => t.id === id);
  if (!task) throw new Error(`${id} isn't one of the tasks on show`);
  return task.entries;
}

/** Task `id`'s view as the tab was last told of it, or why there's none. */
export function shownTask(repoPath: string, id: string): TaskView {
  const task = shownTasks(repoPath)?.find((t) => t.id === id);
  if (!task) throw new Error(`${id} isn't one of the tasks on show`);
  return task;
}

export async function unwatchTasks(): Promise<void> {
  await hub?.unwatchTab();
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
    shownTasks(repoPath)?.find((t) => t.id === id),
    id,
  );
  await open(url);
  return { url };
}
