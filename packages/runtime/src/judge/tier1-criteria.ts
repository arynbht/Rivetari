// Criteria tier 1 settles on its own. "npm run lint and typecheck pass" is
// verified by tier 1's run on the same change, not by anything the reviewer
// can see in a diff, so the reviewer kept calling it unverified. A criterion
// made only of such clauses takes its status from tier 1; one that says
// anything more ("re-exports config; lint passes") is still the reviewer's,
// with tier 1's results in its prompt.
import type { CheckOutcome } from "./outcome.js";

/** The checks a criterion's words name. */
const CHECK_OF: Record<string, string> = {
  lint: "quality.lint.clean",
  typecheck: "quality.typecheck.clean",
  "type-check": "quality.typecheck.clean",
  test: "quality.tests.pass",
  tests: "quality.tests.pass",
};

const CMD = String.raw`(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?)?(?:lint|typecheck|type-check|tests?)`;
const LIST = String.raw`${CMD}(?:\s*,\s*(?:and\s+)?${CMD}|\s+and\s+${CMD})*`;
// Deliberately narrow: "tests pass with TZ=Pacific/Auckland" or "lint, build
// and test pass" say more than tier 1 ran, so they don't match.
const CLAUSE = new RegExp(
  String.raw`^(?:and\s+)?(${LIST})\s+(?:all\s+|still\s+)*pass(?:es)?(?:\s+(?:green|cleanly))?$`,
);
const WORD = /\b(lint|typecheck|type-check|tests?)\b/g;

export type Tier1Checks = readonly Pick<
  CheckOutcome,
  "id" | "title" | "outcome" | "message"
>[];

/**
 * The check ids a criterion names when every clause in it is a plain "these
 * checks pass"; null when any clause says something else.
 */
export function tier1OnlyChecks(text: string): string[] | null {
  const clauses = text
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .split(/;\s*|\.(?:\s+|$)/)
    .map((c) => c.trim())
    .filter(Boolean);
  if (clauses.length === 0) return null;
  const ids = new Set<string>();
  for (const clause of clauses) {
    const list = CLAUSE.exec(clause)?.[1];
    if (!list) return null;
    for (const m of list.matchAll(WORD)) ids.add(CHECK_OF[m[1] ?? ""] ?? "");
  }
  ids.delete("");
  return ids.size > 0 ? [...ids] : null;
}

/**
 * A criterion's status from tier 1 alone, or null when tier 1 doesn't settle
 * it (it says more, or names a check tier 1 didn't run).
 */
export function tier1Status(
  text: string,
  checks: Tier1Checks,
): { status: "met" | "unmet" | "unverified"; note: string } | null {
  const ids = tier1OnlyChecks(text);
  if (!ids) return null;
  const found = ids.map((id) => checks.find((c) => c.id === id));
  if (found.some((c) => !c || c.outcome === "n/a")) return null;
  const ran = found as Tier1Checks[number][];
  const names = ran.map((c) => c.title).join(", ");
  const failed = ran.filter((c) => c.outcome === "fail");
  if (failed.length > 0)
    return {
      status: "unmet",
      note: `tier 1: ${failed.map((c) => c.title).join(", ")} failed on the change`,
    };
  const pre = ran.filter((c) => c.outcome === "pre-existing");
  if (pre.length > 0)
    return {
      status: "unverified",
      note: `tier 1: ${pre.map((c) => c.title).join(", ")} is red on the base and the change alike (pre-existing)`,
    };
  return { status: "met", note: `tier 1 ran green on this change: ${names}` };
}

/** Tier 1's results as the reviewer reads them. */
export function tier1Section(checks: Tier1Checks): string[] {
  const ran = checks.filter((c) => c.outcome !== "n/a");
  if (ran.length === 0) return [];
  return [
    `## Tier 1 (deterministic checks, this round, this change)\nRun by a tool on a clean clone of the base plus this change, never reported by the agent. "pre-existing" means red on the base too. These results are the evidence for any criterion, or part of one, that says lint, typecheck or tests pass: don't call it unverified for want of their output.\n${ran.map((c) => `- ${c.id} (${c.title}): ${c.outcome}${c.outcome === "pass" || !c.message ? "" : ` — ${c.message.replace(/\s+/g, " ").slice(0, 200)}`}`).join("\n")}`,
  ];
}
