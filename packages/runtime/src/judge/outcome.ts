import type { ControlResult } from "@arynbht/rivetari-engine";

/** A check's state on one side: green, red (fail, or could not run), or n/a. */
export type Side = "green" | "red" | "n/a";

export interface CheckOutcome {
  id: string;
  title: string;
  base: Side;
  head: Side;
  /**
   * `pass` green on the change; `fixed` red at base, green now; `fail` red now
   * but not at base (this change broke it, or it can't be checked now);
   * `pre-existing` red on both — reported, not blamed on this change.
   */
  outcome: "pass" | "fixed" | "fail" | "pre-existing" | "n/a";
  message: string;
}

export function outcomeOf(before: Side, after: Side): CheckOutcome["outcome"] {
  if (after === "n/a") return "n/a";
  if (after === "green") return before === "red" ? "fixed" : "pass";
  return before === "red" ? "pre-existing" : "fail";
}

export function side(result: ControlResult | undefined): Side {
  if (!result || result.status === "n/a") return "n/a";
  return result.status === "pass" ? "green" : "red";
}

/** Each head result against the same control's result at base. */
export function compare(
  baseResults: ControlResult[],
  headResults: ControlResult[],
): CheckOutcome[] {
  const baseById = new Map(baseResults.map((r) => [r.controlId, r]));
  return headResults.map((h) => {
    const b = baseById.get(h.controlId);
    const before = side(b);
    const after = side(h);
    const message =
      h.detectors.find((d) => d.status !== "pass")?.message ??
      h.detectors[0]?.message ??
      "";
    return {
      id: h.controlId,
      title: h.title,
      base: before,
      head: after,
      outcome: outcomeOf(before, after),
      message,
    };
  });
}
