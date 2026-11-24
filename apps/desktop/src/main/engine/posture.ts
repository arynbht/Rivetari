// The Posture view's read: the scorecard and the phase lens over the one audit
// `.rivetari/state.json` records, the trend from the posture snapshots in
// `.rivetari/history.jsonl`, and the waivers and evidence on file. Nothing here
// evaluates a control: the lens runs the catalog's gates over the recorded
// results through the engine's inferPhase, the call `rivetari status` makes, so
// the scorecard and the gates read one set of results and agree with the CLI.
// Kept free of any electron import so it unit-tests as plain functions.
import {
  type Control,
  type Gate,
  loadBundledGates,
  PHASES,
  type Waiver,
} from "@arynbht/rivetari-catalog";
import {
  type ControlResult,
  type EvidenceEntry,
  type HistoryEntry,
  inferPhase,
  isEvidenceValid,
  isWaiverActive,
  loadEvidence,
  loadHistory,
  loadProfile,
  loadWaivers,
  parseDuration,
  readRecordedAudit,
  type RecordedAudit,
  waiversExpiringWithin,
} from "@arynbht/rivetari-engine";

import type {
  ExpiryState,
  Posture,
  PostureEvidence,
  PostureLens,
  PostureTrendPoint,
  PostureWaiver,
} from "../../shared/ipc";
import { bundledControls, toScorecard } from "./audit";

/** How far ahead an expiry counts as soon: the window `rivetari audit` warns in. */
export const EXPIRING_DAYS = 30;

const DAY_MS = 86_400_000;

/** The most snapshots the trend draws; CI appends one per run. */
export const TREND_POINTS = 60;

/**
 * The trend from history.jsonl's posture snapshots, oldest first. A row with
 * status counts gives pass, fail and needs-evidence; an older row has only
 * each lane's pass and total, where waived counts as passing and n/a is left
 * out, so its fail and needs-evidence are null rather than guessed.
 */
export function postureTrend(entries: HistoryEntry[]): PostureTrendPoint[] {
  return entries.slice(-TREND_POINTS).map((entry) => {
    if (entry.summary) {
      return {
        date: entry.date,
        pass: entry.summary.pass,
        fail: entry.summary.fail,
        needsEvidence: entry.summary.needsEvidence,
        total: entry.summary.total,
      };
    }
    const lanes = Object.values(entry.byLane);
    return {
      date: entry.date,
      pass: lanes.reduce((n, l) => n + l.pass, 0),
      fail: null,
      needsEvidence: null,
      total: lanes.reduce((n, l) => n + l.total, 0),
    };
  });
}

/** The recorded controls as the results the gates select over. */
function recordedResults(
  recorded: RecordedAudit,
  controls: Control[],
): ControlResult[] {
  const byId = new Map(controls.map((c) => [c.id, c]));
  return recorded.controls.map((r) => {
    const control = byId.get(r.id);
    return {
      controlId: r.id,
      title: control?.title ?? r.id,
      lane: r.lane as ControlResult["lane"],
      phase: r.phase as ControlResult["phase"],
      severity: r.severity as ControlResult["severity"],
      effort: control?.effort,
      status: r.status,
      detectors: [],
      durationMs: 0,
    };
  });
}

/**
 * The phase lens over the recorded audit: the declared phase, the phase the
 * controls put the repo in, and what holds that phase's gate shut.
 */
export function postureLens(
  recorded: RecordedAudit,
  controls: Control[],
  gates: Gate[],
  declaredPhase: string | null,
): PostureLens {
  const declared = PHASES.find((p) => p.key === declaredPhase)?.key ?? null;
  const inference = inferPhase(
    gates,
    recordedResults(recorded, controls),
    declared,
  );
  const at = PHASES.findIndex((p) => p.key === inference.inferredPhase);
  return {
    declaredPhase: declared,
    inferredPhase: inference.inferredPhase,
    allGreen: inference.allGreen,
    nextPhase: at >= 0 ? (PHASES[at + 1]?.key ?? null) : null,
    phases: inference.phases,
    blockers: inference.blockers,
  };
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function waiverView(
  waiver: Waiver,
  titles: Map<string, string>,
  now: Date,
): PostureWaiver {
  const state: ExpiryState = !isWaiverActive(waiver, now)
    ? "expired"
    : waiversExpiringWithin([waiver], EXPIRING_DAYS, now).length > 0
      ? "expiring"
      : "active";
  return {
    control: waiver.control,
    title: titles.get(waiver.control) ?? waiver.control,
    reason: waiver.reason,
    owner: waiver.owner ?? null,
    created: waiver.created ?? null,
    expires: waiver.expires,
    state,
  };
}

/**
 * An evidence entry with when it stops counting. Its own `valid-for` wins and
 * the control's applies otherwise, as the audit decides it (isEvidenceValid).
 */
export function evidenceView(
  entry: EvidenceEntry,
  control: Control | undefined,
  now: Date,
): PostureEvidence {
  const window = entry["valid-for"] ?? control?.["valid-for"];
  const days = window ? parseDuration(window) : null;
  const start = entry.date ? Date.parse(entry.date.slice(0, 10)) : Number.NaN;
  const expiresAt =
    days !== null && !Number.isNaN(start) ? start + days * DAY_MS : null;
  const state: ExpiryState = !isEvidenceValid(
    entry,
    now,
    control?.["valid-for"],
  )
    ? "expired"
    : expiresAt !== null && expiresAt <= now.getTime() + EXPIRING_DAYS * DAY_MS
      ? "expiring"
      : "active";
  return {
    control: entry.control,
    title: control?.title ?? entry.control,
    reviewer: entry.reviewer ?? null,
    date: entry.date ?? null,
    note: entry.note ?? null,
    url: entry.url ?? null,
    expires: expiresAt === null ? null : isoDay(expiresAt),
    state,
  };
}

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** Everything the Posture view shows for a repo. */
export async function readPosture(
  repoPath: string,
  now: Date = new Date(),
): Promise<Posture> {
  const [controls, recorded, history, bundled] = await Promise.all([
    bundledControls(),
    readRecordedAudit(repoPath),
    loadHistory(repoPath),
    loadBundledGates(),
  ]);
  // A gate that didn't load would quietly drop out of the lens and move the
  // inferred phase, so a broken gate catalog fails the read instead.
  if (bundled.errors.length > 0)
    throw new Error(
      `Gate catalog is invalid: ${bundled.errors[0]?.message ?? "unknown error"}`,
    );
  const { gates } = bundled;
  const byId = new Map(controls.map((c) => [c.id, c]));
  const titles = new Map(controls.map((c) => [c.id, c.title]));
  const problems: string[] = [];

  // A profile, waiver or evidence file that doesn't parse is reported beside
  // what still reads, rather than blanking the view.
  const profile = await loadProfile(repoPath).catch((err: unknown) => {
    problems.push(`profile.yml: ${message(err)}`);
    return null;
  });
  const waivers = await loadWaivers(repoPath).catch((err: unknown) => {
    problems.push(message(err));
    return [] as Waiver[];
  });
  const evidence = await loadEvidence(repoPath).catch((err: unknown) => {
    problems.push(message(err));
    return [] as EvidenceEntry[];
  });

  return {
    repoPath,
    scorecard: recorded ? toScorecard(repoPath, recorded, controls) : null,
    lens: recorded
      ? postureLens(recorded, controls, gates, profile?.phase ?? null)
      : null,
    trend: postureTrend(history),
    waivers: waivers.map((w) => waiverView(w, titles, now)),
    evidence: evidence.map((e) => evidenceView(e, byId.get(e.control), now)),
    problems,
  };
}
