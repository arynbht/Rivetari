// Tasks adapter: the runtime's read-only task watcher, kept as a whole list so
// the renderer gets the repo's tasks in one piece after every change. One repo is
// watched at a time (the Tasks tab shows one); watching another, or closing the
// window, stops the last watcher. Nothing here writes a ledger, a lease or a ref.
// Electron-free except the push callback.
import {
  type TaskEvent,
  type TaskView,
  type TaskWatcher,
  watchTasks,
} from "@arynbht/rivetari-runtime";

import type { TasksState } from "../../shared/ipc";

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

let active: TaskWatcher | null = null;

/**
 * Watch `repoPath`'s tasks, replacing any earlier watch. Resolves with the first
 * state; every later change is handed to `onState`.
 */
export async function watchRepoTasks(
  repoPath: string,
  onState: (state: TasksState) => void,
  intervalMs?: number,
): Promise<TasksState> {
  await unwatchTasks();
  let tasks: TaskView[] = [];
  let error: string | null = null;
  const state = (): TasksState => ({ repoPath, tasks, error });
  let settled = false;
  const watcher = watchTasks(
    repoPath,
    (event) => {
      tasks = applyTaskEvent(tasks, event);
      // An error stays on show until the next read that changes something.
      error = event.kind === "error" ? event.message : null;
      // The first snapshot is the reply to the watch call itself.
      if (settled) onState(state());
    },
    intervalMs === undefined ? {} : { intervalMs },
  );
  active = watcher;
  try {
    tasks = await watcher.ready;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  settled = true;
  return state();
}

export async function unwatchTasks(): Promise<void> {
  const watcher = active;
  active = null;
  await watcher?.stop();
}
