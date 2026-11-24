// One person's action on a task, recorded the way the CLI records a beat
// (`onTask` in `rivetari task`): bring the record up to the tasks branch, take
// the task's lease, run the runtime's own call under the person's name (git's
// user.email, as the CLI records it) and push. A failed action still pushes
// what it got through. When only the last push fails, the action is kept on
// this machine and the result says so, the way the CLI warns; its next beat
// pushes it. Answering a stop, confirming a card and approving a route all go
// through here, and nothing else writes a task.
import { resolve } from "node:path";

import {
  commitTask,
  holderName,
  pullTasks,
  whoami,
} from "@arynbht/rivetari-runtime";

/** The runtime calls around every action; a test hands in its own. */
export interface BeatDeps {
  whoami: typeof whoami;
  pullTasks: typeof pullTasks;
  commitTask: typeof commitTask;
}

export const beatDeps: BeatDeps = { whoami, pullTasks, commitTask };

/** A plain Error, so the renderer shows the runtime's message without its class name. */
export const plain = (err: unknown) =>
  new Error(err instanceof Error ? err.message : String(err));

/**
 * Actions being recorded now, by repo and task, with what each is ("an answer
 * to"): a second click on the same task waits its turn.
 */
const recording = new Map<string, string>();

export interface BeatAction<T> {
  /** The beat name in the commit messages, as the CLI writes it ("answer"). */
  beat: string;
  /** What's being recorded, in the busy message: "an answer to". */
  doing: string;
  /** What the warning calls it once recorded: "the answer". */
  noun: string;
  run: (by: string) => Promise<T>;
}

export async function recordBeat<T>(
  repoPath: string,
  id: string,
  action: BeatAction<T>,
  deps: BeatDeps = beatDeps,
): Promise<{ by: string; result: T; warning: string | null }> {
  // Windows paths are case-insensitive: C:\Repo and c:\repo are one repo.
  const path = resolve(repoPath);
  const key = `${process.platform === "win32" ? path.toLowerCase() : path}#${id}`;
  const busy = recording.get(key);
  if (busy !== undefined)
    throw new Error(`${busy} ${id} is already being recorded`);
  recording.set(key, action.doing);
  try {
    const by = await deps.whoami(repoPath);
    const holder = holderName(by);
    await deps.pullTasks(repoPath);
    await deps.commitTask(repoPath, id, {
      holder,
      message: `${id}: ${action.beat}`,
    });
    let result: T;
    try {
      result = await action.run(by);
    } catch (err) {
      // The action's own error is the one to report; a failed push goes with it.
      const pushed = await deps
        .commitTask(repoPath, id, {
          holder,
          message: `${id}: ${action.beat} failed`,
        })
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
        message: `${id}: ${action.beat} done`,
      });
    } catch (err) {
      warning = `${action.noun} is recorded, but pushing it failed: ${plain(err).message}. It's kept on this machine; the next beat on ${id} pushes it.`;
    }
    return { by, result, warning };
  } catch (err) {
    throw plain(err);
  } finally {
    recording.delete(key);
  }
}
