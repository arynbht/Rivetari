// Small cards skip what only pays off on big ones: a separate plan call, and
// the full review model. A low-risk card naming at most two source files (its
// generated files and changesets don't count) is planned from its own
// acceptance criteria and reviewed by a smaller model under a short timeout;
// a review that runs out of time goes to the full one instead.
import type { Card } from "../task/card.js";
import { isGeneratedPath } from "./tier2.js";

export const FAST_REVIEW_MODEL = "claude-sonnet-5-5";
export const FAST_REVIEW_TIMEOUT_MS = 3 * 60_000;

export function sourceTouches(card: Card): string[] {
  return card.touches.filter(
    (t) => !isGeneratedPath(t) && !t.startsWith(".changeset/"),
  );
}

/**
 * `risk` is the effective one: the card's, or at the judge the higher of the
 * card's and the one the diff carries.
 */
export function isFastPath(
  card: Card,
  risk: Card["risk"] = card.risk,
): boolean {
  const files = sourceTouches(card).length;
  return risk === "low" && files > 0 && files <= 2;
}

/** The plan a fast-path card gets instead of a plan call: its criteria. */
export function fastPlan(card: Card): string[] {
  return card.acceptance.map((a) => `${a.id}: ${a.text}`);
}
