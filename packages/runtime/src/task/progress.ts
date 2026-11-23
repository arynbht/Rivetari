// Live progress: while a beat runs, a small file says which beat it is, when it
// started, when it last did something, and (for the build) the agent's turns,
// tokens and last tool so far. The ledger only gets an entry when a step ends,
// so without this a 20-minute build looked frozen. It isn't the record: it sits
// beside the task's directory (`.rivetari/tasks/<id>.progress.json`), never in
// it, so the store never commits it, the ledger never seals it and the judge
// never hashes it. It's written atomically and at most every couple of seconds,
// removed when the beat ends, and a file left by a process that died is ignored.
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentProgress } from "../agent/stream.js";
import type { Beat } from "./ledger.js";
import { TASKS_DIR } from "./tasks.js";

export interface TaskProgress {
  beat: Beat;
  startedAt: string;
  /** The last time the beat did something: an agent event, or a step of its own. */
  lastActivityAt: string;
  /** The agent's model replies so far, for a beat that runs one. */
  turns?: number | undefined;
  tokens?: number | undefined;
  lastTool?: string | undefined;
  /** The process running the beat, so a file it left behind when it died is ignored. */
  pid?: number | undefined;
}

/** The fewest milliseconds between two writes of one task's progress. */
export const PROGRESS_THROTTLE_MS = 2000;
/**
 * Progress older than this is ignored even when its pid is alive: by then the
 * pid is far more likely to be another process than a beat still going.
 */
export const PROGRESS_STALE_MS = 12 * 60 * 60 * 1000;

export const progressPath = (repoPath: string, id: string) =>
  join(repoPath, TASKS_DIR, `${id}.progress.json`);

/** Is `pid` a live process? EPERM means it is, but isn't ours to signal. */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const isProgress = (value: unknown): value is TaskProgress =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as TaskProgress).beat === "string" &&
  typeof (value as TaskProgress).startedAt === "string" &&
  typeof (value as TaskProgress).lastActivityAt === "string";

/**
 * Task `id`'s progress, or null when no beat is running: no file, one that
 * doesn't parse, or one a dead process (or a very old one) left behind.
 */
export async function readProgress(
  repoPath: string,
  id: string,
  options: { now?: Date; alive?: (pid: number) => boolean } = {},
): Promise<TaskProgress | null> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(progressPath(repoPath, id), "utf8"));
  } catch {
    return null;
  }
  if (!isProgress(value)) return null;
  const now = (options.now ?? new Date()).getTime();
  const last = Date.parse(value.lastActivityAt);
  if (!Number.isFinite(last) || now - last > PROGRESS_STALE_MS) return null;
  if (typeof value.pid === "number" && !(options.alive ?? isAlive)(value.pid))
    return null;
  return value;
}

/**
 * Writes one beat's progress. `update` records activity now and writes it,
 * throttled; `finish` removes the file. A write that fails is dropped: progress
 * is for watching, and must never fail the beat it watches.
 */
export class ProgressWriter {
  private state: TaskProgress;
  private lastWrite = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private writing: Promise<void> = Promise.resolve();
  private finished = false;
  private readonly clock: () => Date;
  private readonly throttleMs: number;

  constructor(
    private readonly repoPath: string,
    private readonly id: string,
    beat: Beat,
    options: { now?: () => Date; throttleMs?: number } = {},
  ) {
    this.clock = options.now ?? (() => new Date());
    this.throttleMs = options.throttleMs ?? PROGRESS_THROTTLE_MS;
    const at = this.clock().toISOString();
    this.state = {
      beat,
      startedAt: at,
      lastActivityAt: at,
      pid: process.pid,
    };
  }

  /** Write the beat's start at once. */
  start(): Promise<void> {
    return this.flush();
  }

  /** The beat did something: an agent event (with its totals), or a step. */
  update(agent?: AgentProgress): void {
    if (this.finished) return;
    this.state = {
      ...this.state,
      ...(agent
        ? { turns: agent.turns, tokens: agent.tokens, lastTool: agent.lastTool }
        : {}),
      lastActivityAt: this.clock().toISOString(),
    };
    if (this.timer) return;
    const wait = this.lastWrite + this.throttleMs - this.clock().getTime();
    if (wait <= 0) {
      void this.flush();
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, wait);
    this.timer.unref?.();
  }

  private flush(): Promise<void> {
    const snapshot = this.state;
    this.lastWrite = this.clock().getTime();
    this.writing = this.writing.then(async () => {
      if (this.finished) return;
      const path = progressPath(this.repoPath, this.id);
      const temp = `${path}.${process.pid}.tmp`;
      try {
        await writeFile(temp, `${JSON.stringify(snapshot)}\n`, "utf8");
        // Atomic: a reader sees the old file or the new one, never half of one.
        await rename(temp, path);
      } catch {
        // A reader holding the file on Windows, say; the next write tries again.
        await rm(temp, { force: true }).catch(() => undefined);
      }
    });
    return this.writing;
  }

  /** The beat ended: stop writing and remove the file. */
  async finish(): Promise<void> {
    this.finished = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.writing;
    await rm(progressPath(this.repoPath, this.id), { force: true }).catch(
      () => undefined,
    );
  }
}

/** Run `beat` with its progress written while it runs and removed after. */
export async function trackBeat<T>(
  repoPath: string,
  id: string,
  beat: Beat,
  run: (progress: ProgressWriter) => Promise<T>,
  options: { now?: () => Date; throttleMs?: number } = {},
): Promise<T> {
  const writer = new ProgressWriter(repoPath, id, beat, options);
  await writer.start();
  try {
    return await run(writer);
  } finally {
    await writer.finish();
  }
}
