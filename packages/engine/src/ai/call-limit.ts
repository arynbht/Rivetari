// A limit on every `claude -p` call. One hung for six hours overnight with
// nothing to stop it, so each call gets a deadline (RIVETARI_CALL_TIMEOUT_MINUTES,
// default 20), and a caller can set a wall-clock budget that ends whichever call
// is in flight when it runs out. Either one kills the call's whole process tree:
// on Windows `claude` runs under a cmd.exe shim, and killing only the shim leaves
// claude running with the pipes still open.
import { AsyncLocalStorage } from "node:async_hooks";
import { type ChildProcess, spawn } from "node:child_process";

export const DEFAULT_CALL_TIMEOUT_MINUTES = 20;
export const CALL_TIMEOUT_ENV = "RIVETARI_CALL_TIMEOUT_MINUTES";

/** Which limit ended a call: its own timeout, or the budget around it. */
export type TimeLimit = "call" | "budget";

/** setTimeout fires at once past this, so a huge limit is capped to it. */
const MAX_TIMER_MS = 2_147_483_647;

export class CallTimeoutError extends Error {
  readonly limit: TimeLimit;
  readonly minutes: number;
  /** The environment variable that sets the limit that fired. */
  readonly env: string;
  /** `killed` is false when the budget ran out between calls. */
  constructor(limit: TimeLimit, minutes: number, env: string, killed = true) {
    super(
      limit === "call"
        ? `a claude call ran past its ${minutes}-minute limit (${env}) and was killed`
        : `the ${minutes}-minute budget (${env}) ran out${killed ? " during a claude call, which was killed" : ""}`,
    );
    this.name = "CallTimeoutError";
    this.limit = limit;
    this.minutes = minutes;
    this.env = env;
  }
}

/** A positive number of minutes from `name`, or `fallback` when unset or invalid. */
export function minutesFromEnv(
  name: string,
  fallback: number,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[name]?.trim();
  const minutes = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(minutes) && minutes > 0 ? minutes : fallback;
}

export function callTimeoutMinutes(env: NodeJS.ProcessEnv = process.env) {
  return minutesFromEnv(CALL_TIMEOUT_ENV, DEFAULT_CALL_TIMEOUT_MINUTES, env);
}

interface Budget {
  deadline: number;
  minutes: number;
  env: string;
}

// Ambient rather than passed down: the calls a task run makes sit under the
// build beat, the judge, its review and the AI client, and none of those should
// need a parameter to be stopped by the run's budget.
const budgets = new AsyncLocalStorage<Budget>();

/** Run `fn` with a wall-clock budget that every call inside it is held to. */
export function withTimeBudget<T>(
  budget: { minutes: number; env: string },
  fn: () => Promise<T>,
): Promise<T> {
  return budgets.run(
    { ...budget, deadline: Date.now() + budget.minutes * 60_000 },
    fn,
  );
}

/** The budget's error once it has run out, so a caller can stop between calls. */
export function budgetSpent(): CallTimeoutError | undefined {
  const budget = budgets.getStore();
  return budget && Date.now() >= budget.deadline
    ? new CallTimeoutError("budget", budget.minutes, budget.env, false)
    : undefined;
}

/** Kill a child and everything it started. */
export function killTree(child: ChildProcess): void {
  if (
    child.pid === undefined ||
    child.exitCode !== null ||
    child.signalCode !== null
  )
    return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
    }).on("error", () => child.kill());
    return;
  }
  child.kill("SIGTERM");
  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
  }, 5000).unref();
}

/**
 * Spawn `command`, feed it `input`, and resolve its stdout, killing it when its
 * call limit or the surrounding budget runs out (whichever comes first) or when
 * `signal` aborts.
 */
export function spawnWithLimit(
  command: string,
  argv: readonly string[],
  options: {
    input: string;
    cwd?: string | undefined;
    env?: NodeJS.ProcessEnv | undefined;
    signal?: AbortSignal | undefined;
    /** A non-zero exit whose output this accepts still resolves (a call stopped at its turn limit). */
    accept?: ((stdout: string) => boolean) | undefined;
  },
): Promise<string> {
  const callMinutes = callTimeoutMinutes();
  const budget = budgets.getStore();
  const left = budget ? budget.deadline - Date.now() : Infinity;
  const limit: TimeLimit = left < callMinutes * 60_000 ? "budget" : "call";
  const timeout = () =>
    limit === "budget" && budget
      ? new CallTimeoutError("budget", budget.minutes, budget.env)
      : new CallTimeoutError("call", callMinutes, CALL_TIMEOUT_ENV);
  if (left <= 0) return Promise.reject(timeout());
  const ms = Math.min(callMinutes * 60_000, left, MAX_TIMER_MS);

  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, [...argv], {
      windowsHide: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    let settled = false;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      settle();
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish(() => reject(timeout()));
    }, ms);
    const onAbort = () => {
      if (settled) return;
      killTree(child);
      finish(() =>
        reject(
          options.signal?.reason instanceof Error
            ? options.signal.reason
            : new Error("the claude call was aborted"),
        ),
      );
    };
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => finish(() => reject(err)));
    child.on("close", (code) =>
      finish(() =>
        code === 0 || options.accept?.(stdout)
          ? resolve(stdout)
          : reject(
              new Error(stderr.trim() || `claude exited with code ${code}`),
            ),
      ),
    );
    // A child that exits early closes stdin; its exit code says why, not EPIPE.
    child.stdin.on("error", () => undefined);
    child.stdin.end(options.input);
  });
}
