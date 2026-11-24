// The audit adapter. Scorecard shows the audit recorded in `.rivetari/state.json`,
// read through the engine, so the shell and `rivetari audit` can't disagree: the
// shell never evaluates a second copy of its own. Run audit evaluates every
// control and writes state.json through the same engine calls the CLI uses
// (evaluateControls, then writeAuditState), then shows what was recorded. Each
// recorded control is joined with the catalog for its title, rationale and
// references so the UI can show them on expand.
//
// The CLI also ratchets the coverage baseline in `.rivetari/quality.json` after
// an audit. That file is committed, so the shell leaves it alone: changing it
// belongs in a task, not a button.
import {
  LANES,
  loadBundledCatalog,
  type Control,
} from "@arynbht/rivetari-catalog";
import {
  buildContext,
  type ControlResult,
  evaluateControls,
  readRecordedAudit,
  type RecordedAudit,
  writeAuditState,
} from "@arynbht/rivetari-engine";

import {
  type Scorecard,
  type ScorecardControl,
  type ScorecardLane,
  type StatusCounts,
} from "../../shared/ipc";

function emptyCounts(): StatusCounts {
  return { pass: 0, fail: 0, needsEvidence: 0, waived: 0, skip: 0, na: 0 };
}

function bump(counts: StatusCounts, status: ControlResult["status"]): void {
  switch (status) {
    case "pass":
      counts.pass += 1;
      break;
    case "fail":
      counts.fail += 1;
      break;
    case "needs-evidence":
      counts.needsEvidence += 1;
      break;
    case "waived":
      counts.waived += 1;
      break;
    case "skip":
      counts.skip += 1;
      break;
    case "n/a":
      counts.na += 1;
      break;
  }
}

/** The most useful one-line message for a control result. */
function summarize(result: ControlResult): string {
  const failing = result.detectors.find((d) => d.status === "fail");
  if (failing) return failing.message;
  if (result.status === "waived" && result.waiver) {
    return `waived: ${result.waiver.reason}`;
  }
  const skipped = result.detectors.find((d) => d.status === "skip");
  if (skipped) return skipped.message;
  return result.detectors[0]?.message ?? "";
}

export async function bundledControls(): Promise<Control[]> {
  const { controls, errors } = await loadBundledCatalog();
  if (errors.length > 0) {
    throw new Error(
      `Catalog is invalid: ${errors[0]?.message ?? "unknown error"}`,
    );
  }
  return controls;
}

/**
 * Shape a recorded audit as the lane scorecard. state.json keeps each control's
 * status but not its detector messages, so `messages` carries them when the
 * audit was just run here; a scorecard read from disk has none.
 */
export function toScorecard(
  repoPath: string,
  recorded: RecordedAudit,
  controls: Control[],
  messages: Map<string, string> = new Map(),
): Scorecard {
  const byId = new Map<string, Control>(controls.map((c) => [c.id, c]));

  // Prime every lane in catalog order; drop the empty ones at the end.
  const lanes = new Map<string, ScorecardLane>();
  for (const lane of LANES) {
    lanes.set(lane.key, {
      key: lane.key,
      title: lane.title,
      counts: emptyCounts(),
      controls: [],
    });
  }

  for (const result of recorded.controls) {
    const lane = lanes.get(result.lane);
    if (!lane) continue;
    // A control recorded by an older catalog may be gone from this one; it
    // still shows, under its id.
    const control = byId.get(result.id);
    const entry: ScorecardControl = {
      controlId: result.id,
      title: control?.title ?? result.id,
      status: result.status,
      severity: result.severity,
      message: messages.get(result.id) ?? "",
      rationale: control?.rationale ?? "",
      references: (control?.references ?? []).map((ref) => ({
        name: ref.name,
        url: ref.url,
        ...(ref.section ? { section: ref.section } : {}),
      })),
    };
    lane.controls.push(entry);
    bump(lane.counts, result.status);
  }

  return {
    repoPath,
    generatedAt: recorded.generatedAt,
    // The recorded summary counts every control, even one whose lane isn't in
    // this catalog's view, so the totals match what the CLI reports.
    totals: { ...recorded.summary },
    lanes: [...lanes.values()].filter((lane) => lane.controls.length > 0),
  };
}

/** The scorecard of the audit recorded in state.json, or null when there's none. */
export async function readScorecard(
  repoPath: string,
): Promise<Scorecard | null> {
  const recorded = await readRecordedAudit(repoPath);
  if (!recorded) return null;
  return toScorecard(repoPath, recorded, await bundledControls());
}

/**
 * Run an audit over a local repo the way `rivetari audit` does, record it in
 * state.json, and return the recorded scorecard. With a GitHub token (from the
 * signed-in user, M5.3) the github-api detectors run too; without one they skip.
 * Kept free of any electron import so it unit-tests as a plain function.
 */
export async function runAudit(
  repoPath: string,
  token?: string,
): Promise<Scorecard> {
  const controls = await bundledControls();
  const ctx = buildContext(repoPath, token ? { token } : {});
  // Every control, as the CLI evaluates and records them: `severity-floor` trims
  // what the CLI's report prints, never what it records.
  const results = await evaluateControls(controls, ctx);
  await writeAuditState(repoPath, results);

  const recorded = await readRecordedAudit(repoPath);
  if (!recorded) {
    throw new Error("the audit ran but .rivetari/state.json has no results");
  }
  const messages = new Map(results.map((r) => [r.controlId, summarize(r)]));
  return toScorecard(repoPath, recorded, controls, messages);
}
