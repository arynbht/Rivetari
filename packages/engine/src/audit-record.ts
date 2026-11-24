// Recording an audit: what `rivetari audit` writes to `.rivetari/state.json` after
// it evaluates the controls, and the reader that gives it back. The CLI and the
// desktop shell both record through here, so the shell shows the same numbers the
// CLI does instead of working out its own.
import type { AuditContext } from "./context.js";
import type { ControlResult, ControlStatus } from "./evaluate.js";
import { ratchetCoverageBaseline } from "./quality.js";
import { loadState, saveState } from "./state.js";

/** Status counts over a set of results. */
export interface AuditSummary {
  pass: number;
  fail: number;
  needsEvidence: number;
  waived: number;
  skip: number;
  na: number;
  total: number;
}

/** One control's result as state.json keeps it. */
export interface RecordedControl {
  id: string;
  status: ControlStatus;
  lane: string;
  phase: string;
  severity: string;
}

/** The last recorded audit: when it ran, its summary and each control's result. */
export interface RecordedAudit {
  generatedAt: string | null;
  summary: AuditSummary;
  controls: RecordedControl[];
}

export function summarizeResults(
  results: Pick<ControlResult, "status">[],
): AuditSummary {
  const summary: AuditSummary = {
    pass: 0,
    fail: 0,
    needsEvidence: 0,
    waived: 0,
    skip: 0,
    na: 0,
    total: results.length,
  };
  for (const r of results) {
    if (r.status === "pass") summary.pass++;
    else if (r.status === "fail") summary.fail++;
    else if (r.status === "needs-evidence") summary.needsEvidence++;
    else if (r.status === "waived") summary.waived++;
    else if (r.status === "n/a") summary.na++;
    else summary.skip++;
  }
  return summary;
}

/** Write the audit's summary and per-control results into state.json. */
export async function writeAuditState(
  repoPath: string,
  results: ControlResult[],
): Promise<void> {
  // Preserve the managed-file hash registry (written by `rivetari fix`) across audits.
  const state = await loadState(repoPath);
  state.version = 1;
  state.generatedAt = new Date().toISOString();
  state.summary = summarizeResults(results);
  state.controls = results.map((r) => ({
    id: r.controlId,
    status: r.status,
    lane: r.lane,
    phase: r.phase,
    severity: r.severity,
  }));
  await saveState(repoPath, state);
}

/**
 * Record an evaluated audit the way `rivetari audit` does: write state.json, then
 * record the coverage baseline at the first measured run and raise it when
 * coverage improves (it never moves down). The ratchet is best-effort; returns the
 * new baseline when it moved, otherwise null.
 */
export async function recordAudit(
  ctx: AuditContext,
  results: ControlResult[],
  now: Date = new Date(),
): Promise<number | null> {
  await writeAuditState(ctx.repoPath, results);
  return ratchetCoverageBaseline(ctx, now.toISOString().slice(0, 10)).catch(
    () => null,
  );
}

const STATUSES = new Set<string>([
  "pass",
  "fail",
  "skip",
  "needs-evidence",
  "waived",
  "n/a",
]);

function recordedControl(raw: unknown): RecordedControl | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.status !== "string") return null;
  if (!STATUSES.has(r.status)) return null;
  return {
    id: r.id,
    status: r.status as ControlStatus,
    lane: typeof r.lane === "string" ? r.lane : "",
    phase: typeof r.phase === "string" ? r.phase : "",
    severity: typeof r.severity === "string" ? r.severity : "",
  };
}

/**
 * The audit last recorded in state.json, or null when none has been (no file, or
 * one that only holds `rivetari fix`'s hash registry). Entries that don't parse
 * are left out, and the summary is counted from the entries that remain so the
 * two always agree.
 */
export async function readRecordedAudit(
  repoPath: string,
): Promise<RecordedAudit | null> {
  const state = await loadState(repoPath);
  if (!Array.isArray(state.controls)) return null;
  const controls = state.controls
    .map(recordedControl)
    .filter((c): c is RecordedControl => c !== null);
  return {
    generatedAt:
      typeof state.generatedAt === "string" ? state.generatedAt : null,
    summary: summarizeResults(controls),
    controls,
  };
}
