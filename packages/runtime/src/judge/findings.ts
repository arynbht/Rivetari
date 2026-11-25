import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { TaskFinding, TaskHistoryRow } from "../ship/close.js";
import { judgeGit } from "./git.js";
import { DIFF_RULES } from "./diff-rules.js";
import { changeChecks } from "./tier1.js";

export interface PatternCount extends TaskFinding {
  prs: string[];
}

export interface FindingsMetrics {
  reviewed: number;
  /** Every finding, blocking and suggestion alike. */
  findings: number;
  blocking: number;
  suggestions: number;
  /** Blocking findings only, as the ladder counts them; suggestions don't block. */
  findingsPerPr: number | null;
  tier1Rules: { catalog: number; diff: number; total: number };
  patterns: PatternCount[];
  candidates: PatternCount[];
}

function taskRows(text: string): TaskHistoryRow[] {
  return text.split("\n").flatMap((line) => {
    try {
      const row = JSON.parse(line) as Partial<TaskHistoryRow>;
      return row.kind === "task" && row.task ? [row as TaskHistoryRow] : [];
    } catch {
      return [];
    }
  });
}

export async function historyRows(repoPath: string): Promise<TaskHistoryRow[]> {
  const local = await readFile(
    join(repoPath, ".rivetari", "history.jsonl"),
    "utf8",
  ).catch(() => "");
  const branch = await judgeGit(repoPath)
    .show(["refs/heads/rivetari/tasks:history.jsonl"])
    .catch(() => "");
  const rows = new Map<string, TaskHistoryRow>();
  for (const row of [...taskRows(branch), ...taskRows(local)])
    if (!rows.has(row.task) || row.findings) rows.set(row.task, row);
  return [...rows.values()];
}

export async function findingsMetrics(
  repoPath: string,
  rows?: TaskHistoryRow[],
): Promise<FindingsMetrics> {
  const reviewed = (rows ?? (await historyRows(repoPath))).filter(
    (r) => r.findings !== undefined,
  );
  const byPattern = new Map<string, PatternCount>();
  for (const row of reviewed)
    for (const f of row.findings ?? []) {
      const entry = byPattern.get(f.pattern) ?? { ...f, prs: [] };
      const pr = row.pr === null ? row.task : `#${row.pr}`;
      if (!entry.prs.includes(pr)) entry.prs.push(pr);
      byPattern.set(f.pattern, entry);
    }
  const patterns = [...byPattern.values()].sort(
    (a, b) => b.prs.length - a.prs.length || a.pattern.localeCompare(b.pattern),
  );
  const all = reviewed.flatMap((r) => r.findings ?? []);
  const suggestions = all.filter((f) => f.kind === "suggestion").length;
  const blocking = all.length - suggestions;
  const catalog = (await changeChecks()).length;
  return {
    reviewed: reviewed.length,
    findings: all.length,
    blocking,
    suggestions,
    findingsPerPr: reviewed.length > 0 ? blocking / reviewed.length : null,
    tier1Rules: {
      catalog,
      diff: DIFF_RULES.length,
      total: catalog + DIFF_RULES.length,
    },
    patterns,
    candidates: patterns.filter((p) => p.prs.length >= 2),
  };
}
