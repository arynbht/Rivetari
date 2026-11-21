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
