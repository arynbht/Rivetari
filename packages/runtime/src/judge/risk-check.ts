// The judge derives the card's risk again, from the change it judges rather
// than the touches intake read: the files it changed, the lines it changed,
// and existing tests it edited that the card didn't name. The higher of that
// and the card's risk is the one the rest of the judge and the PR go by.
import picomatch from "picomatch";
import { simpleGit } from "simple-git";

import type { Card } from "../task/card.js";
import {
  deriveRisk,
  higherRisk,
  isHigher,
  type Risk,
  touchedPaths,
} from "../task/risk.js";
import { isTestFile, parseNameStatus } from "./protected.js";

export interface JudgedRisk {
  /** The card's risk, as intake left it. */
  card: Risk;
  /** The higher of the card's and the change's. */
  effective: Risk;
  /** Why it was raised; empty when it wasn't. */
  reasons: string[];
}

/** Each file's added and removed lines, from a `git diff -U0`. */
export function changedLines(diff: string): Map<string, string[]> {
  const lines = new Map<string, string[]>();
  let file: string | undefined;
  let header = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      header = true;
      file = undefined;
      continue;
    }
    if (header) {
      // The new path names the file; a deleted file only has the old one.
      // git ends the header with a tab when the path has a space in it.
      const path = /^(?:---|\+\+\+) (?:[ab]\/)?(.*?)\t?$/.exec(line)?.[1];
      if (path !== undefined && path !== "/dev/null") file = path;
      if (line.startsWith("@@")) header = false;
      continue;
    }
    if (!file || !(line.startsWith("+") || line.startsWith("-"))) continue;
    lines.set(file, [...(lines.get(file) ?? []), line.slice(1)]);
  }
  return lines;
}

const above = (reason: string, risk: Risk) =>
  isHigher((reason.split(":")[0] ?? "low") as Risk, risk);

/**
 * A diff as git stores it: paths unquoted, and no external diff or textconv
 * from the user's config hiding the lines the line signal reads.
 */
const PLAIN = [
  "-c",
  "core.quotePath=false",
  "diff",
  "--no-ext-diff",
  "--no-textconv",
];

export async function judgeRisk(options: {
  repoPath: string;
  base: string;
  head: string;
  card: Card;
  /** The repo's sensitive list (the assembly's stop-and-ask touches). */
  sensitive: readonly string[];
}): Promise<JudgedRisk> {
  const { card } = options;
  const git = simpleGit(options.repoPath);
  const diff = parseNameStatus(
    await git.raw([
      ...PLAIN,
      "--name-status",
      "-M",
      options.base,
      options.head,
    ]),
  );
  const isNamed =
    card.touches.length > 0
      ? picomatch([...card.touches], { dot: true })
      : undefined;
  const named = (path: string) => isNamed?.(path) ?? false;
  const paths = diff.flatMap((e) => [
    e.path,
    ...(e.oldPath ? [e.oldPath] : []),
  ]);
  const unnamedTests = diff
    .filter((e) => {
      const at = [e.path, ...(e.oldPath ? [e.oldPath] : [])];
      return e.status !== "A" && at.some(isTestFile) && !at.some(named);
    })
    .map((e) => e.path);
  const fromDiff = deriveRisk({
    paths,
    sensitive: options.sensitive,
    unnamedTests,
    lines: changedLines(
      await git.raw([
        ...PLAIN,
        "-U0",
        "--no-color",
        options.base,
        options.head,
      ]),
    ),
  });
  // The touches again, so a card edited by hand to a lower risk doesn't count.
  const fromTouches = deriveRisk({
    paths: await touchedPaths(options.repoPath, card.touches),
  });
  const effective = higherRisk(
    card.risk,
    higherRisk(fromTouches.risk, fromDiff.risk),
  );
  return {
    card: card.risk,
    effective,
    reasons:
      effective === card.risk
        ? []
        : [...new Set([...fromTouches.reasons, ...fromDiff.reasons])].filter(
            (r) => above(r, card.risk),
          ),
  };
}
