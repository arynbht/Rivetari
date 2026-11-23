// `rivetari task run --parallel N`: run up to N tasks at once, each through
// `runTask` with its own worktree, lease and ledger, exactly as a single run.
// Two tasks whose `touches` could name the same file never run side by side:
// the later one waits until the one it overlaps with has finished, so two
// agents are never editing one file at once. The later task is still cut from
// the default branch, not from the earlier one's, so whichever PR merges
// second may need a rebase. A card that names no touches could change
// anything, so it runs alone.
import picomatch from "picomatch";

import type { RunOutcome } from "./run.js";

export interface ParallelTask {
  id: string;
  touches: readonly string[];
}

/** shipped: the run ended with ship; stopped: it waits on a person; errored: it threw. */
export type ParallelStatus = "shipped" | "stopped" | "errored";

export interface ParallelResult {
  id: string;
  status: ParallelStatus;
  /** What the task waits on now, or the error it stopped with. */
  next: string;
}

export interface ParallelOptions {
  /** How many tasks may run at once (1 or more). */
  parallel: number;
  run: (id: string) => Promise<RunOutcome>;
  onStart?: ((id: string) => void) | undefined;
  /** Called once per task that has to wait, with the tasks it waits for. */
  onWait?: ((id: string, behind: string[]) => void) | undefined;
}

const GLOB_CHAR = /[*?[\]{}()!+@]/;

const normalize = (path: string) =>
  path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/** A plain path might name a directory, so it covers what's under it too. */
function covers(entry: string): string[] {
  const path = normalize(entry);
  return picomatch.scan(path).isGlob ? [path] : [path, `${path}/**`];
}

/** Can no file name match both segments? Only says yes when that's certain. */
function namesDisjoint(a: string, b: string): boolean {
  if (a === "**" || b === "**") return false;
  const globA = GLOB_CHAR.test(a);
  const globB = GLOB_CHAR.test(b);
  if (!globA && !globB) return a !== b;
  if (!globA) return !picomatch(b, { dot: true })(a);
  if (!globB) return !picomatch(a, { dot: true })(b);
  // Every match starts with the literal text before the first wildcard and
  // ends with the text after the last one.
  const head = (s: string) => s.slice(0, s.search(GLOB_CHAR));
  const tail = (s: string) => {
    let last = -1;
    for (let i = 0; i < s.length; i++) if (GLOB_CHAR.test(s[i] ?? "")) last = i;
    return s.slice(last + 1);
  };
  const [headA, headB, tailA, tailB] = [head(a), head(b), tail(a), tail(b)];
  return (
    !(headA.startsWith(headB) || headB.startsWith(headA)) ||
    !(tailA.endsWith(tailB) || tailB.endsWith(tailA))
  );
}

/**
 * Could one file match both patterns? Segments line up from the front until
 * either pattern reaches a `**`, and from the back the same way; one pair
 * that can't match the same name settles it. When that can't be shown, the
 * answer is yes: a pair that waits for nothing costs time, two tasks on one
 * file cost a conflict.
 */
function patternsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  // A brace holding a slash spans segments, so they no longer line up.
  if (/\{[^}]*\/[^}]*\}/.test(a) || /\{[^}]*\/[^}]*\}/.test(b)) return true;
  const sa = a.split("/");
  const sb = b.split("/");
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const [x, y] = [sa[i] ?? "", sb[i] ?? ""];
    if (x === "**" || y === "**") break;
    if (namesDisjoint(x, y)) return false;
  }
  for (let i = 1; i <= n; i++) {
    const [x, y] = [sa.at(-i) ?? "", sb.at(-i) ?? ""];
    if (x === "**" || y === "**") break;
    if (namesDisjoint(x, y)) return false;
  }
  // Without a `**`, a pattern only matches paths of its own depth.
  return sa.includes("**") || sb.includes("**") || sa.length === sb.length;
}

/** Could the two cards' touches (paths or globs) name the same file? */
export function touchesOverlap(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length === 0 || b.length === 0) return true;
  const pa = a.flatMap(covers);
  const pb = b.flatMap(covers);
  return pa.some((x) => pb.some((y) => patternsOverlap(x, y)));
}

/**
 * Run the tasks, at most `parallel` at once, in the order given: a task
 * starts once nothing running and nothing ahead of it in the queue overlaps
 * its touches. Never throws: a task that throws is `errored`. Results come
 * back in the order given.
 */
export async function runParallel(
  tasks: readonly ParallelTask[],
  options: ParallelOptions,
): Promise<ParallelResult[]> {
  const limit = Math.max(1, Math.floor(options.parallel));
  const results = new Map<string, ParallelResult>();
  const pending = [...tasks];
  const active: ParallelTask[] = [];
  const running = new Set<Promise<void>>();
  const told = new Set<string>();

  const start = (task: ParallelTask) => {
    active.push(task);
    options.onStart?.(task.id);
    const done = options
      .run(task.id)
      .then(
        (outcome): ParallelResult => ({
          id: task.id,
          status: outcome.ran.at(-1) === "ship" ? "shipped" : "stopped",
          next: outcome.next,
        }),
        (err: unknown): ParallelResult => ({
          id: task.id,
          status: "errored",
          next: err instanceof Error ? err.message : String(err),
        }),
      )
      .then((result) => {
        results.set(task.id, result);
        active.splice(active.indexOf(task), 1);
        running.delete(done);
      });
    running.add(done);
  };

  while (pending.length > 0 || running.size > 0) {
    for (let i = 0; i < pending.length && running.size < limit;) {
      const task = pending[i] as ParallelTask;
      const behind = [...active, ...pending.slice(0, i)].filter((other) =>
        touchesOverlap(task.touches, other.touches),
      );
      if (behind.length > 0) {
        if (!told.has(task.id)) {
          told.add(task.id);
          options.onWait?.(
            task.id,
            behind.map((t) => t.id),
          );
        }
        i++;
        continue;
      }
      pending.splice(i, 1);
      start(task);
    }
    // Nothing running means the queue's head had nothing ahead and started.
    if (running.size === 0) break;
    await Promise.race(running);
  }
  return tasks.map(
    (t) =>
      results.get(t.id) ?? { id: t.id, status: "errored", next: "never ran" },
  );
}

/** 1 if any task errored, else 2 if any waits on a person, else 0. */
export function parallelExitCode(results: readonly ParallelResult[]): number {
  if (results.some((r) => r.status === "errored")) return 1;
  return results.some((r) => r.status === "stopped") ? 2 : 0;
}

/**
 * One at a time: isolate picks the lowest port no other task's env.json
 * holds and adds a worktree, so two tasks isolating together could take
 * the same port.
 */
export function oneAtATime(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>) => {
    const run = tail.then(fn);
    tail = run.catch(() => undefined);
    return run;
  };
}
