// The Now view's two new actions, confirming a card and approving a route,
// recorded through the runtime's own calls exactly as `rivetari task confirm`
// and `rivetari task approve` record them (task-beat.ts), plus two reads for
// the queue: a judge's findings, and the PR a task shipped. Each action is
// checked against what the person was shown: a card or assembly that changed
// since is refused, and they're asked to look again.
import {
  approveRoute,
  confirmTask,
  type JudgeRecord,
  loadJudgeRecord,
  loadTask,
  nextStep,
  type TaskView,
} from "@arynbht/rivetari-runtime";

import type {
  NowActionRequest,
  NowActionResult,
  NowFinding,
  NowJudge,
} from "../../shared/ipc";
import { cardDigest } from "./now";
import { beatDeps, type BeatDeps, plain, recordBeat } from "./task-beat";
import { prUrlOf } from "./tasks";

export interface ConfirmDeps extends BeatDeps {
  loadTask: typeof loadTask;
  confirmTask: typeof confirmTask;
}

export interface ApproveDeps extends BeatDeps {
  approveRoute: typeof approveRoute;
}

const confirmDeps: ConfirmDeps = { ...beatDeps, loadTask, confirmTask };
const approveDeps: ApproveDeps = { ...beatDeps, approveRoute };

/**
 * Confirm task `id`'s card, as `rivetari task confirm` does. `shown` is the
 * digest of the card the person read; the card is read again after the pull,
 * and a different one isn't confirmed.
 */
export async function confirmCard(
  repoPath: string,
  { id, shown }: Pick<NowActionRequest, "id" | "shown">,
  deps: ConfirmDeps = confirmDeps,
): Promise<NowActionResult> {
  const { by, result, warning } = await recordBeat(
    repoPath,
    id,
    {
      beat: "confirm",
      doing: "a confirmation of",
      noun: "the confirmation",
      run: async (by) => {
        const now = await deps.loadTask(repoPath, id, { readOnly: true });
        if (cardDigest(now.card) !== shown)
          throw new Error(
            `${id}'s card changed since it was shown; read it again before confirming`,
          );
        return deps.confirmTask(repoPath, id, { by });
      },
    },
    deps,
  );
  return { id, by, next: nextStep(result), warning };
}

/**
 * Approve task `id`'s route, as `rivetari task approve` does. `shown` is the
 * sha256 of the assembly.yml the person read, which the runtime checks itself.
 */
export async function approveAssembly(
  repoPath: string,
  { id, shown }: Pick<NowActionRequest, "id" | "shown">,
  deps: ApproveDeps = approveDeps,
): Promise<NowActionResult> {
  const { by, result, warning } = await recordBeat(
    repoPath,
    id,
    {
      beat: "approve",
      doing: "an approval of",
      noun: "the approval",
      run: (by) => deps.approveRoute(repoPath, id, { by, shown }),
    },
    deps,
  );
  return { id, by, next: nextStep(result.task), warning };
}

const findingOf = (f: {
  kind: string;
  title: string;
  file?: string | null | undefined;
  line?: number | null | undefined;
  detail?: string | null | undefined;
}): NowFinding => ({
  kind: f.kind,
  title: f.title,
  file: f.file ?? null,
  line: f.line ?? null,
  detail: f.detail ?? null,
});

/** What the queue shows of a judge round. */
export function judgeView(record: JudgeRecord | null): NowJudge {
  if (!record) return null;
  return {
    round: record.round,
    verdict: record.verdict,
    blocking: (record.review?.blocking ?? []).map(findingOf),
    suggestions: (record.review?.suggestions ?? []).map(findingOf),
    acceptance: (record.review?.acceptance ?? [])
      .filter((a) => a.status !== "met")
      .map((a) => ({ id: a.id, status: a.status, note: a.note ?? "" })),
    protectedPaths: record.tier1.protected.map((p) => `${p.path}: ${p.detail}`),
    notes: record.tier1.notes,
  };
}

export interface JudgeDeps {
  loadTask: typeof loadTask;
  loadJudgeRecord: typeof loadJudgeRecord;
}

/**
 * Task `id`'s latest judge round, from this machine's copy of the record
 * (round files aren't on the watcher's view), checked against the seal in the
 * ledger by the runtime.
 */
export async function judgeFindings(
  repoPath: string,
  id: string,
  deps: JudgeDeps = { loadTask, loadJudgeRecord },
): Promise<NowJudge> {
  try {
    const task = await deps.loadTask(repoPath, id, { readOnly: true });
    return judgeView(await deps.loadJudgeRecord(repoPath, task));
  } catch (err) {
    throw plain(err);
  }
}

/** Open task `id`'s PR from the hub's view of it (see prUrlOf). */
export async function openNowPr(
  views: TaskView[],
  id: string,
  open: (url: string) => Promise<void>,
): Promise<{ url: string }> {
  const url = prUrlOf(
    views.find((t) => t.id === id),
    id,
  );
  await open(url);
  return { url };
}
