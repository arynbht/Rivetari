// `rivetari metrics`: the DORA keys, the trust ladder, the judge's findings
// and the cost flags, as text or JSON. It lives in the runtime rather than the
// CLI so the desktop shell reads the same numbers from the same functions.
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildContext,
  computeMetrics,
  loadHistory,
  type Metrics,
  resolveToken,
} from "@arynbht/rivetari-engine";

import {
  type FindingsMetrics,
  findingsMetrics,
  historyRows,
} from "../judge/findings.js";
import type { TaskHistoryRow } from "../ship/close.js";
import { ladder, type LadderState } from "../task/ladder.js";

export interface MetricsFlags {
  json?: boolean;
  window?: string;
  token?: string;
  findings?: boolean;
}

const pct = (n: number | null) =>
  n === null ? "n/a" : `${Math.round(n * 100)}%`;

export function verificationLines(l: LadderState, indent = ""): string[] {
  if (l.verification.length === 0) return [];
  return [
    `${indent}The autonomy ledger (.rivetari/autonomy/ledger.jsonl) failed verification:`,
    ...l.verification.map((p) => `${indent}  - ${p}`),
    `${indent}Until it verifies, this repo runs supervised.`,
  ];
}

export function renderLadder(l: LadderState): string {
  const n = l.numbers;
  const r = n.rules;
  const level = (name: "review-at-pr" | "unattended") =>
    l.unmet[name].length === 0
      ? `  ${name.padEnd(13)} earned`
      : `  ${name.padEnd(13)} not earned: ${l.unmet[name].join("; ")}`;
  return [
    "Trust ladder",
    "",
    `  Autonomy               ${l.configured}${l.effective !== l.configured ? ` (running at ${l.effective}: ${l.fallback})` : ""}${l.entry ? ` · ${l.entry.kind} on ${l.entry.at.slice(0, 10)}` : ""}`,
    ...verificationLines(l, "  "),
    `  Tier 1 rules           ${r.total} (${r.checks} checks, ${r.diff} diff rules, ${r.boundaries} boundary rules, ${r.lint} lint rules, ${r.banned} banned patterns) · ${r.fromFindings} from findings, ${r.defaults} stack defaults, ${r.total - r.fromFindings - r.defaults} built in or by hand${n.rulesAtEntry !== null ? `; ${n.rulesAtEntry} at entry` : ""}`,
    `  Blocking per PR        ${n.last10.blockingPerPr === null ? "n/a" : n.last10.blockingPerPr.toFixed(2)} over ${n.last10.prs} reviewed PR(s)`,
    `  First-pass merge       ${pct(n.firstPass.rate)} of ${n.firstPass.merged} merged PR(s)`,
    `  Since entering         ${n.sinceEntry.blocking} blocking finding(s) over ${n.sinceEntry.prs} PR(s); falls back above 5 over five`,
    `  Reverts in 7 days      ${n.reverts.length > 0 ? n.reverts.join("; ") : "none"}`,
    `  Rejection rate         ${pct(n.rejection.rate)} of ${n.rejection.prs} PR(s)`,
    "",
    level("review-at-pr"),
    level("unattended"),
  ].join("\n");
}

export function renderFindings(f: FindingsMetrics): string {
  const lines = [
    "Judge findings",
    "",
    `  Tier 1 rules              ${f.tier1Rules.total} (${f.tier1Rules.catalog} checks, ${f.tier1Rules.diff} diff rules)`,
    `  Reviewed tasks            ${f.reviewed}`,
    `  Blocking findings per PR  ${f.findingsPerPr === null ? "n/a" : f.findingsPerPr.toFixed(2)}`,
    `  Suggestions               ${f.suggestions}${f.reviewed > 0 ? ` (${(f.suggestions / f.reviewed).toFixed(1)} per PR, not blocking)` : ""}`,
    `  Distinct patterns         ${f.patterns.length}`,
    "",
    "Pattern recurrence:",
    ...(f.patterns.length > 0
      ? f.patterns.map(
          (p) =>
            `  ${p.pattern}  ${p.prs.length} PR(s)  ${p.kind}: ${p.title} (${p.prs.join(", ")})`,
        )
      : ["  none yet"]),
    "",
    "Candidate rules (a pattern seen in 2+ PRs):",
    ...(f.candidates.length > 0
      ? f.candidates.map(
          (p) => `  ${p.pattern}  ${p.kind}: ${p.title} (${p.prs.join(", ")})`,
        )
      : ["  none yet"]),
  ];
  return lines.join("\n");
}

export function costFlags(rows: TaskHistoryRow[]): TaskHistoryRow[] {
  return rows.filter((r) => r.risk === "low" && r.cost_usd > 1);
}

export function renderCost(rows: TaskHistoryRow[]): string {
  const flagged = costFlags(rows);
  return [
    "Cost",
    "",
    "Low-risk tasks over $1:",
    ...(flagged.length > 0
      ? flagged.map(
          (r) =>
            `  ${r.task}  $${r.cost_usd.toFixed(2)}  ${r.prompt_tokens === undefined ? "n/a" : r.prompt_tokens} prompt tokens`,
        )
      : ["  none: no low-risk task cost over $1"]),
  ].join("\n");
}

export interface RunMetricsOptions {
  now?: Date | undefined;
  token?: string | null | undefined;
}

/** `rivetari metrics` — the four DORA keys for the repo, from the GitHub API. */
export async function runMetrics(
  path: string,
  flags: MetricsFlags,
  options: RunMetricsOptions = {},
): Promise<number> {
  const root = resolve(path);
  try {
    if (!(await stat(root)).isDirectory()) {
      console.error(`rivetari metrics: not a directory: ${path}`);
      return 1;
    }
  } catch {
    console.error(`rivetari metrics: path not found: ${path}`);
    return 1;
  }

  const findings = await findingsMetrics(root);
  const trust = await ladder(root, { now: options.now });
  const rows = await historyRows(root);
  const cost = costFlags(rows);
  if (flags.findings) {
    process.stdout.write(
      flags.json
        ? `${JSON.stringify({ findings, ladder: trust, cost }, null, 2)}\n`
        : `${renderLadder(trust)}\n\n${renderFindings(findings)}\n\n${renderCost(rows)}\n`,
    );
    return 0;
  }

  const token =
    options.token === null
      ? undefined
      : (options.token ?? resolveToken(flags.token));
  const ctx = buildContext(root, { token, now: options.now });
  const gh = await ctx.github();
  if (!gh) {
    console.error(
      "rivetari metrics: a GitHub token and an origin remote are required (set GITHUB_TOKEN or run `gh auth login`).",
    );
    return 1;
  }

  const windowDays = flags.window ? Number(flags.window) : undefined;
  if (
    windowDays !== undefined &&
    (!Number.isFinite(windowDays) || windowDays <= 0)
  ) {
    console.error(
      `rivetari metrics: --window must be a positive number of days.`,
    );
    return 1;
  }

  const metrics = await computeMetrics(gh, {
    now: options.now ?? new Date(),
    windowDays,
  });
  const history = await loadHistory(root);

  if (flags.json) {
    process.stdout.write(
      `${JSON.stringify({ metrics, history, findings, ladder: trust, cost }, null, 2)}\n`,
    );
    return 0;
  }

  process.stdout.write(
    `${renderDora(metrics, history.length)}\n\n${renderLadder(trust)}\n\n${renderFindings(findings)}\n\n${renderCost(rows)}\n`,
  );
  return 0;
}

function num(value: number | null, unit: string, digits = 1): string {
  return value === null ? "n/a" : `${value.toFixed(digits)}${unit}`;
}

function renderDora(m: Metrics, historyPoints: number): string {
  const lines = [
    `DORA metrics (last ${m.windowDays} days)`,
    "",
    `  Deployment frequency   ${num(m.deploymentFrequencyPerWeek, " / week", 2)}`,
    `  Lead time for changes  ${num(m.leadTimeHoursMedian, " h (median)")}`,
    `  Change failure rate    ${
      m.changeFailureRate === null
        ? "n/a"
        : `${(m.changeFailureRate * 100).toFixed(1)}%`
    }`,
    `  Time to restore        ${num(m.timeToRestoreHoursMedian, " h (median)")}`,
    "",
    "Assumptions:",
    ...m.assumptions.map((a) => `  - ${a}`),
  ];
  if (historyPoints > 0) {
    lines.push(
      "",
      `Hygiene trend: ${historyPoints} snapshot(s) in .rivetari/history.jsonl`,
    );
  }
  return lines.join("\n");
}
