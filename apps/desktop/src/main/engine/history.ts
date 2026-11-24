// The History view's read: every closed task with what it cost, and the
// numbers `rivetari metrics` works out from the same rows (the runtime's
// closedTasks, taskMetrics, findingsMetrics and costFlags, so the CLI and the
// shell can't disagree). All local reads: no model, no network, and nothing is
// written, so a sealed ledger.md is never rendered again from here.
// Kept free of any electron import so it unit-tests as plain functions.
import {
  closedTasks,
  costFlags,
  findingsMetrics,
  historyRows,
  loadTask,
  taskMetrics,
} from "@arynbht/rivetari-runtime";

import type { HistoryFindings, HistoryView } from "../../shared/ipc";

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export interface HistoryDeps {
  historyRows: typeof historyRows;
  closedTasks: typeof closedTasks;
  findingsMetrics: typeof findingsMetrics;
}

const defaultHistoryDeps: HistoryDeps = {
  historyRows,
  closedTasks,
  findingsMetrics,
};

const NO_FINDINGS: HistoryFindings = {
  reviewed: 0,
  findings: 0,
  blocking: 0,
  suggestions: 0,
  findingsPerPr: null,
  tier1Rules: { catalog: 0, diff: 0, total: 0 },
  patterns: [],
  candidates: [],
};

/** Closed tasks, their spend, the judge's findings and the cost flags. */
export async function readHistory(
  repoPath: string,
  deps: HistoryDeps = defaultHistoryDeps,
): Promise<HistoryView> {
  const problems: string[] = [];
  const rows = await deps.historyRows(repoPath);
  const tasks = await deps.closedTasks(repoPath, rows);
  // The findings count the catalog's checks too; a catalog that won't load
  // leaves the findings out and says why rather than failing the whole view.
  const findings = await deps
    .findingsMetrics(repoPath, rows)
    .catch((err: unknown) => {
      problems.push(`The judge's findings can't be counted: ${message(err)}`);
      return null;
    });
  return {
    repoPath,
    summary: taskMetrics(tasks),
    tasks,
    findings: findings
      ? {
          reviewed: findings.reviewed,
          findings: findings.findings,
          blocking: findings.blocking,
          suggestions: findings.suggestions,
          findingsPerPr: findings.findingsPerPr,
          tier1Rules: findings.tier1Rules,
          patterns: findings.patterns,
          candidates: findings.candidates,
        }
      : NO_FINDINGS,
    costFlags: costFlags(rows).map((r) => ({
      task: r.task,
      costUsd: r.cost_usd,
      promptTokens: r.prompt_tokens ?? null,
    })),
    problems,
  };
}

const SHIP_PR_URL = /^draft PR (?:opened|updated): #\d+ (\S+)/;

/**
 * Open a closed task's PR from its own ledger, read-only, never from a URL
 * the renderer sends. A ledger that doesn't verify, or a link that isn't
 * https, isn't opened. The Tasks tab's openPr needs the task on show there;
 * this works from History alone.
 */
export async function openHistoryPr(
  repoPath: string,
  id: string,
  open: (url: string) => Promise<void>,
  read: typeof loadTask = loadTask,
): Promise<{ url: string }> {
  const task = await read(repoPath, id, { readOnly: true });
  if (task.problems.length > 0)
    throw new Error(
      `${id}'s record fails verification; its PR link isn't opened`,
    );
  const entry = [...task.entries]
    .reverse()
    .find((e) => e.beat === "ship" && SHIP_PR_URL.test(e.text));
  const raw = entry ? SHIP_PR_URL.exec(entry.text)?.[1] : undefined;
  if (!raw) throw new Error(`${id} has no recorded PR link`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${id}'s PR link isn't a URL: ${raw}`);
  }
  if (url.protocol !== "https:")
    throw new Error(`${id}'s PR link isn't https: ${raw}`);
  await open(url.href);
  return { url: url.href };
}
