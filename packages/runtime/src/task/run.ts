// `rivetari task run <id>`: after a person has confirmed the card and approved
// the route, take the task through isolate → build → prove → judge → ship,
// one beat at a time, and stop wherever a person is needed — a stop-and-ask
// question, a judge that needs a human, the open PR, a build that keeps
// failing its proof, or a run that has used up its wall-clock budget. Each
// ledger entry is reported as it lands.
import {
  budgetSpent,
  CallTimeoutError,
  minutesFromEnv,
  withTimeBudget,
} from "@arynbht/rivetari-engine";

import { type AgentRunner, buildTask } from "../agent/build.js";
import { isolateTask } from "../agent/isolate.js";
import { judgeTask, type JudgeTaskOptions } from "../judge/task-judge.js";
import { proveTask, type ProveOptions } from "../proof/prove.js";
import type { RouteContext } from "../router/task-route.js";
import { shipTask, type ShipOptions } from "../ship/ship.js";
import { advanceTask } from "./autonomy.js";
import type { LedgerEntry } from "./ledger.js";
import { loadTask, nextStep, type Task, TaskError } from "./tasks.js";

/** Build rounds one run may start before it hands the task back to a person. */
export const MAX_BUILDS_PER_RUN = 4;

/**
 * The wall-clock budget of one run, so a hung call or a looping agent can't
 * run all night: it kills the claude call in flight, and stops the run before
 * a build or judge beat once it's spent. RIVETARI_TASK_BUDGET_MINUTES
 * overrides it.
 */
export const DEFAULT_TASK_BUDGET_MINUTES = 90;
export const TASK_BUDGET_ENV = "RIVETARI_TASK_BUDGET_MINUTES";

export function taskBudgetMinutes(env: NodeJS.ProcessEnv = process.env) {
  return minutesFromEnv(TASK_BUDGET_ENV, DEFAULT_TASK_BUDGET_MINUTES, env);
}

export interface RunTaskOptions {
  by: string;
  model?: string | undefined;
  /** The ref isolate cuts the worktree from (default: origin's default branch). */
  base?: string | undefined;
  /** Other tasks' ids, so isolate picks a free port. */
  otherTasks?: string[] | undefined;
  /** Called with each ledger entry as it lands. */
  onEntry?: ((entry: LedgerEntry) => void) | undefined;
  /** Replaceable in tests. */
  agent?: AgentRunner | undefined;
  prove?: Partial<ProveOptions> | undefined;
  judge?: Partial<JudgeTaskOptions> | undefined;
  ship?: Partial<ShipOptions> | undefined;
  now?: Date | undefined;
  context?: RouteContext | undefined;
}

export interface RunOutcome {
  task: Task;
  /** The beats run, in order. */
  ran: string[];
  /** What the task waits on now (its next step). */
  next: string;
}

/**
 * Stop a build or judge beat that a time limit ended, as a stop-and-ask: the
 * person answers, and the next run starts the beat again.
 */
async function stopForTime(
  task: Task,
  beat: "build" | "judge",
  limit: CallTimeoutError,
  options: { by: string; now?: Date | undefined },
): Promise<void> {
  const entry = {
    beat,
    by: `rivetari runtime (for ${options.by})`,
    at: options.now,
  };
  await task.ledger.append({
    ...entry,
    section: "stop",
    text: `asked: timeout: ${limit.message}`,
  });
  await task.ledger.append({
    ...entry,
    section: "timeline",
    text: `${beat} stopped: the ${limit.limit === "call" ? "call timeout" : "task budget"} of ${limit.minutes} min (${limit.env}) ran out`,
  });
}

/** The beat a next step can be run by the driver, or null when a person acts. */
function runnable(
  next: string,
): "isolate" | "build" | "prove" | "judge" | "ship" | null {
  if (next.startsWith("isolate:")) return "isolate";
  if (next.startsWith("build:")) return "build";
  if (next === "prove" || next === "judge" || next === "ship") return next;
  return null;
}

export async function runTask(
  repoPath: string,
  id: string,
  options: RunTaskOptions,
): Promise<RunOutcome> {
  let task = await loadTask(repoPath, id);
  if (task.problems.length > 0)
    throw new TaskError(`task ${id} fails verification; not running`);
  let seen = task.entries.length;
  const report = async () => {
    task = await loadTask(repoPath, id);
    for (const e of task.entries.slice(seen)) options.onEntry?.(e);
    seen = task.entries.length;
  };
  if (!task.confirmed || !task.approved) {
    const advance = await advanceTask(repoPath, id, {
      by: options.by,
      now: options.now,
      context: options.context,
    });
    await report();
    if (advance.waiting) return { task, ran: [], next: advance.waiting };
  }
  if (!task.confirmed || !task.approved)
    throw new TaskError(
      `task ${id} needs a person first: ${nextStep(task)} (run only starts after the card is confirmed and the route approved)`,
    );

  const ran: string[] = [];
  let builds = 0;
  const common = { by: options.by, now: options.now };
  return withTimeBudget(
    { minutes: taskBudgetMinutes(), env: TASK_BUDGET_ENV },
    async (): Promise<RunOutcome> => {
      for (;;) {
        const next = nextStep(task);
        const beat = runnable(next);
        if (!beat) return { task, ran, next };
        if (beat === "build" && ++builds > MAX_BUILDS_PER_RUN)
          return {
            task,
            ran,
            next: `stopped after ${MAX_BUILDS_PER_RUN} build rounds without a passing proof and judge; read the ledger (\`rivetari task resume ${id}\`), then run again`,
          };
        // Only build and judge call claude; the beats between them are short.
        const calls = beat === "build" || beat === "judge";
        const spent = calls ? budgetSpent() : undefined;
        if (spent && calls) {
          await stopForTime(task, beat, spent, common);
          await report();
          return { task, ran, next: nextStep(task) };
        }
        ran.push(beat);
        let stopped = false;
        try {
          if (beat === "isolate")
            await isolateTask(repoPath, id, {
              ...common,
              base: options.base,
              otherTasks: options.otherTasks,
            });
          else if (beat === "build")
            await buildTask(repoPath, id, {
              ...common,
              model: options.model,
              agent: options.agent,
            });
          else if (beat === "prove")
            await proveTask(repoPath, id, { ...options.prove, ...common });
          else if (beat === "judge")
            await judgeTask(repoPath, id, { ...options.judge, ...common });
          else {
            await shipTask(repoPath, id, { ...options.ship, ...common });
          }
        } catch (err) {
          if (!(err instanceof CallTimeoutError) || !calls) throw err;
          await stopForTime(task, beat, err, common);
          stopped = true;
        } finally {
          await report();
        }
        if (stopped) return { task, ran, next: nextStep(task) };
        // A beat that ran without moving the task on would otherwise run forever.
        if (beat !== "build" && nextStep(task) === next)
          throw new TaskError(
            `${beat} ran but ${id} is still at "${next}"; read the ledger (\`rivetari task resume ${id}\`)`,
          );
      }
    },
  );
}
