// Closed tasks and what they cost, from `.rivetari/history.jsonl` and each
// task's ledger: the history row keeps the totals close wrote, and the ledger
// adds what the row leaves out (the title, when it closed, when its PR opened,
// and how much of the spend was the judge's). The desktop shell's History view
// reads these rather than working the numbers out itself.
import { historyRows } from "../judge/findings.js";
import { type TaskHistoryRow, usageTotals } from "../ship/close.js";
import { isSeal } from "../task/ledger.js";
import { loadTask, type Task } from "../task/tasks.js";

/** The ship beat's record of the PR it opened or updated. */
const SHIPPED = /^draft PR (?:opened|updated): #\d+/;

export interface ClosedTask {
  id: string;
  /** The card's title; null when the task's records aren't here to read. */
  title: string | null;
  outcome: TaskHistoryRow["outcome"];
  pr: number | null;
  costUsd: number;
  tokens: number;
  buildRounds: number;
  judgeRounds: number;
  /** Build rounds that were retries; null for rows close wrote before it counted them. */
  retryRounds: number | null;
  /** Wall minutes from the card to the close, as close measured them. */
  minutes: number;
  risk: string | null;
  skills: string[];
  /** When the ledger was sealed (ISO), else the history row's date. */
  closedAt: string;
  /** Minutes from the card being drafted to its PR opening; null with no PR. */
  cardToPrMinutes: number | null;
  /** The judge's share of the cost, from the ledger; null without one. */
  judgeCostUsd: number | null;
  /** Why the ledger added nothing, when it didn't. */
  ledgerProblem: string | null;
}

const minutesBetween = (from: string, to: string) =>
  Math.round((Date.parse(to) - Date.parse(from)) / 6_000) / 10;

/**
 * What the judge's rounds cost: the same usage notes usageTotals adds up,
 * over the judge's entries alone, since the history row only keeps the sum.
 */
export function judgeUsage(task: Task): { tokens: number; costUsd: number } {
  return usageTotals({
    ...task,
    entries: task.entries.filter((e) => e.beat === "judge"),
  });
}

/**
 * Every closed task, newest first. A row whose ledger is missing or doesn't
 * verify still shows, with what the row alone says and the reason.
 */
export async function closedTasks(
  repoPath: string,
  rows?: TaskHistoryRow[],
): Promise<ClosedTask[]> {
  const tasks: ClosedTask[] = [];
  for (const row of rows ?? (await historyRows(repoPath))) {
    const base: ClosedTask = {
      id: row.task,
      title: null,
      outcome: row.outcome,
      pr: row.pr,
      costUsd: row.cost_usd,
      tokens: row.tokens,
      buildRounds: row.build_rounds,
      judgeRounds: row.judge_rounds,
      retryRounds: row.rounds ? row.rounds.filter((r) => r.retry).length : null,
      minutes: row.minutes,
      risk: row.risk ?? null,
      skills: row.skills,
      closedAt: row.date,
      cardToPrMinutes: null,
      judgeCostUsd: null,
      ledgerProblem: null,
    };
    // Read-only: a history view never re-renders a sealed task's ledger.md.
    const task = await loadTask(repoPath, row.task, { readOnly: true }).catch(
      (err: unknown) => (err instanceof Error ? err.message : String(err)),
    );
    if (typeof task === "string") {
      tasks.push({ ...base, ledgerProblem: task });
      continue;
    }
    if (task.problems.length > 0) {
      tasks.push({
        ...base,
        title: task.card.title,
        ledgerProblem: `its ledger doesn't verify: ${task.problems[0]}`,
      });
      continue;
    }
    const first = task.entries[0];
    const opened = task.entries.find(
      (e) => e.beat === "ship" && SHIPPED.test(e.text),
    );
    const sealed = task.entries.find(isSeal);
    tasks.push({
      ...base,
      title: task.card.title,
      closedAt: sealed?.at ?? row.date,
      cardToPrMinutes:
        first && opened ? minutesBetween(first.at, opened.at) : null,
      judgeCostUsd: Math.round(judgeUsage(task).costUsd * 100) / 100,
    });
  }
  return tasks.sort(
    (a, b) => b.closedAt.localeCompare(a.closedAt) || b.id.localeCompare(a.id),
  );
}

export interface SpendDay {
  /** The day the tasks closed (YYYY-MM-DD). */
  date: string;
  merged: number;
  mergedUsd: number;
  abandonedUsd: number;
  /** PRs closed without merging. */
  closedUsd: number;
}

export interface TaskMetrics {
  tasks: number;
  merged: number;
  abandoned: number;
  /** Closed without merging (the PR was closed, the task not abandoned). */
  closed: number;
  spend: {
    totalUsd: number;
    mergedUsd: number;
    abandonedUsd: number;
    closedUsd: number;
    /** All spend over merged tasks: what a merged change costs, waste included. */
    perMergedUsd: number | null;
    /** The median merged task's own cost. */
    mergedMedianUsd: number | null;
    /** Abandoned spend over all spend. */
    abandonedShare: number | null;
  };
  judge: {
    costUsd: number;
    /** The judge's cost over the spend of the tasks whose ledgers say it. */
    share: number | null;
    /** How many tasks' ledgers could be read for it. */
    tasks: number;
  };
  rounds: {
    build: number;
    judge: number;
    /** Retries among the build rounds of rows that count them. */
    retries: number;
    retryShare: number | null;
    /** Tasks that needed more than one build round. */
    multiBuild: number;
  };
  cardToPr: { medianMinutes: number | null; tasks: number };
  /** Spend per closing day, oldest first. */
  trend: SpendDay[];
}

const cents = (n: number) => Math.round(n * 100) / 100;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const share = (part: number, whole: number) =>
  whole > 0 ? part / whole : null;

/** The numbers the History view leads with, over every closed task. */
export function taskMetrics(tasks: ClosedTask[]): TaskMetrics {
  const sum = (list: ClosedTask[]) =>
    cents(list.reduce((n, t) => n + t.costUsd, 0));
  const merged = tasks.filter((t) => t.outcome === "merged");
  const abandoned = tasks.filter((t) => t.outcome === "abandoned");
  const closed = tasks.filter((t) => t.outcome === "closed");
  const totalUsd = sum(tasks);
  const abandonedUsd = sum(abandoned);

  const judged = tasks.filter((t) => t.judgeCostUsd !== null);
  const judgeUsd = cents(judged.reduce((n, t) => n + t.judgeCostUsd!, 0));

  const counted = tasks.filter((t) => t.retryRounds !== null);
  const retries = counted.reduce((n, t) => n + t.retryRounds!, 0);
  const countedRounds = counted.reduce((n, t) => n + t.buildRounds, 0);

  const toPr = tasks.flatMap((t) =>
    t.cardToPrMinutes === null ? [] : [t.cardToPrMinutes],
  );

  const days = new Map<string, SpendDay>();
  for (const t of tasks) {
    const date = t.closedAt.slice(0, 10);
    const day = days.get(date) ?? {
      date,
      merged: 0,
      mergedUsd: 0,
      abandonedUsd: 0,
      closedUsd: 0,
    };
    if (t.outcome === "merged") {
      day.merged += 1;
      day.mergedUsd = cents(day.mergedUsd + t.costUsd);
    } else if (t.outcome === "abandoned")
      day.abandonedUsd = cents(day.abandonedUsd + t.costUsd);
    else day.closedUsd = cents(day.closedUsd + t.costUsd);
    days.set(date, day);
  }

  return {
    tasks: tasks.length,
    merged: merged.length,
    abandoned: abandoned.length,
    closed: closed.length,
    spend: {
      totalUsd,
      mergedUsd: sum(merged),
      abandonedUsd,
      closedUsd: sum(closed),
      perMergedUsd: merged.length > 0 ? cents(totalUsd / merged.length) : null,
      mergedMedianUsd: median(merged.map((t) => t.costUsd)),
      abandonedShare: share(abandonedUsd, totalUsd),
    },
    judge: {
      costUsd: judgeUsd,
      share: share(judgeUsd, sum(judged)),
      tasks: judged.length,
    },
    rounds: {
      build: tasks.reduce((n, t) => n + t.buildRounds, 0),
      judge: tasks.reduce((n, t) => n + t.judgeRounds, 0),
      retries,
      retryShare: share(retries, countedRounds),
      multiBuild: tasks.filter((t) => t.buildRounds > 1).length,
    },
    cardToPr: { medianMinutes: median(toPr), tasks: toPr.length },
    trend: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
