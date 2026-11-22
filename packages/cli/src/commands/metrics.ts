import { stat } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildContext,
  computeMetrics,
  loadHistory,
  type Metrics,
  resolveToken,
} from "@arynbht/factory-engine";
import {
  type FindingsMetrics,
  findingsMetrics,
} from "@arynbht/factory-runtime";

export interface MetricsFlags {
  json?: boolean;
  window?: string;
  token?: string;
  findings?: boolean;
}

export function renderFindings(f: FindingsMetrics): string {
  const lines = [
    "Judge findings",
    "",
    `  Tier 1 rules           ${f.tier1Rules.total} (${f.tier1Rules.catalog} checks, ${f.tier1Rules.diff} diff rules)`,
    `  Reviewed tasks         ${f.reviewed}`,
    `  Findings per PR        ${f.findingsPerPr === null ? "n/a" : f.findingsPerPr.toFixed(1)}`,
    `  Distinct patterns      ${f.patterns.length}`,
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

export interface RunMetricsOptions {
  now?: Date | undefined;
  token?: string | null | undefined;
}

/** `factory metrics` — the four DORA keys for the repo, from the GitHub API. */
export async function runMetrics(
  path: string,
  flags: MetricsFlags,
  options: RunMetricsOptions = {},
): Promise<number> {
  const root = resolve(path);
  try {
    if (!(await stat(root)).isDirectory()) {
      console.error(`factory metrics: not a directory: ${path}`);
      return 1;
    }
  } catch {
    console.error(`factory metrics: path not found: ${path}`);
    return 1;
  }

  const findings = await findingsMetrics(root);
  if (flags.findings) {
    process.stdout.write(
      flags.json
        ? `${JSON.stringify({ findings }, null, 2)}\n`
        : `${renderFindings(findings)}\n`,
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
      "factory metrics: a GitHub token and an origin remote are required (set GITHUB_TOKEN or run `gh auth login`).",
    );
    return 1;
  }

  const windowDays = flags.window ? Number(flags.window) : undefined;
  if (
    windowDays !== undefined &&
    (!Number.isFinite(windowDays) || windowDays <= 0)
  ) {
    console.error(
      `factory metrics: --window must be a positive number of days.`,
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
      `${JSON.stringify({ metrics, history, findings }, null, 2)}\n`,
    );
    return 0;
  }

  process.stdout.write(
    `${render(metrics, history.length)}\n\n${renderFindings(findings)}\n`,
  );
  return 0;
}

function num(value: number | null, unit: string, digits = 1): string {
  return value === null ? "n/a" : `${value.toFixed(digits)}${unit}`;
}

function render(m: Metrics, historyPoints: number): string {
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
      `Hygiene trend: ${historyPoints} snapshot(s) in .factory/history.jsonl`,
    );
  }
  return lines.join("\n");
}
