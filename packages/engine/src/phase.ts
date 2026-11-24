// Which phase a repo's controls put it in, and what holds it there. `rivetari
// status` and the desktop's Posture view both ask, so both get the answer from
// here rather than each working out its own.
import {
  EFFORTS,
  type Gate,
  PHASES,
  SEVERITIES,
} from "@arynbht/rivetari-catalog";

import type { ControlResult, ControlStatus } from "./evaluate.js";
import { evaluateGate, type GateStatus } from "./gates.js";

/** One phase's gate; `status` is null where the gate is absent or selects nothing. */
export interface PhaseGateStatus {
  phase: string;
  title: string;
  status: GateStatus | null;
}

/** A control that holds the inferred phase's gate shut. */
export interface PhaseBlocker {
  controlId: string;
  title: string;
  status: Extract<ControlStatus, "fail" | "needs-evidence">;
  severity: string;
  effort: string;
}

export interface PhaseInference {
  /** The phase the controls put the repo in; null when no gate is defined. */
  inferredPhase: string | null;
  /** Every defined gate is green. */
  allGreen: boolean;
  /** Every phase, in order, with its gate's status. */
  phases: PhaseGateStatus[];
  /** What blocks the inferred phase's gate, by severity then effort. */
  blockers: PhaseBlocker[];
}

/**
 * Infer the phase from evaluated controls: the lowest-order phase whose gate is
 * defined and not green, but never below `declaredPhase`, which is a floor the
 * person set (a shipped product without a discovery brief is not "in
 * discovery"). Pass every control's result: `severity-floor` trims what reports
 * show, never the bar a phase is judged against.
 */
export function inferPhase(
  gates: Gate[],
  results: ControlResult[],
  declaredPhase?: string | null,
): PhaseInference {
  // A gate that selects zero controls is "undefined for this profile", not a
  // blocker: it's treated like an absent gate so it never pins inference (an
  // empty discovery gate must not make every repo look stuck at "discovery").
  const gateByPhase = new Map(gates.map((g) => [g.phase, g]));
  const perPhase = PHASES.map((p) => {
    const gate = gateByPhase.get(p.key);
    const evaluated = gate ? evaluateGate(gate, results) : null;
    return {
      phase: p.key as string,
      title: p.title as string,
      order: p.order as number,
      status:
        evaluated && evaluated.controls.length > 0 ? evaluated.status : null,
      controls: evaluated?.controls ?? [],
    };
  });

  const floorOrder = PHASES.find((p) => p.key === declaredPhase)?.order ?? 0;
  const firstBlocked = perPhase.find(
    (p) => p.status && p.status !== "green" && p.order >= floorOrder,
  );
  const allGreen = perPhase.some((p) => p.status) && !firstBlocked;
  // When every defined gate is green the repo is at the furthest phase; it comes
  // from the phase list rather than a hardcoded "operate".
  const lastPhase = PHASES[PHASES.length - 1]?.key ?? null;

  return {
    inferredPhase: firstBlocked?.phase ?? (allGreen ? lastPhase : null),
    allGreen,
    phases: perPhase.map(({ phase, title, status }) => ({
      phase,
      title,
      status,
    })),
    blockers: firstBlocked ? blockersOf(firstBlocked.controls) : [],
  };
}

function blockersOf(controls: ControlResult[]): PhaseBlocker[] {
  return controls
    .filter(
      (c): c is ControlResult & { status: PhaseBlocker["status"] } =>
        c.status === "fail" || c.status === "needs-evidence",
    )
    .map((c) => ({
      controlId: c.controlId,
      title: c.title,
      status: c.status,
      severity: c.severity,
      effort: c.effort ?? "medium",
    }))
    .sort(
      (a, b) =>
        SEVERITIES.indexOf(a.severity as (typeof SEVERITIES)[number]) -
          SEVERITIES.indexOf(b.severity as (typeof SEVERITIES)[number]) ||
        EFFORTS.indexOf(a.effort as (typeof EFFORTS)[number]) -
          EFFORTS.indexOf(b.effort as (typeof EFFORTS)[number]),
    );
}
