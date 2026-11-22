import picomatch from "picomatch";

import type { Card } from "../task/card.js";
import { type DiffEntry, SUPPRESSION } from "./protected.js";
import type { CheckOutcome } from "./outcome.js";
import type { Hunk } from "./tier1.js";

export const DIFF_RULES = [
  {
    id: "diff.no-new-comments",
    title: "The change adds no code comments",
  },
  {
    id: "diff.markdown-in-card",
    title: "Every Markdown file the change adds or edits is named in the card",
  },
  {
    id: "diff.no-new-suppressions",
    title: "The change adds no check suppressions or skipped tests",
  },
] as const;

export interface DiffRuleOptions {
  card?: Card | undefined;
  noNewComments?: boolean | undefined;
  /** The diff's hunks: with them, a comment line that replaces one isn't new. */
  hunks?: ReadonlyMap<string, readonly Hunk[]> | undefined;
  allowedSuppressions?: ReadonlySet<string> | undefined;
}

const CODE = /\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|rb|sh|cs|swift|php)$/i;
const HASH_COMMENTS = /\.(?:py|rb|sh)$/i;
const MARKDOWN = /\.mdx?$/i;
const SKIPPED_TEST =
  /\b(?:it|test|describe|suite|context)\.(?:skip|only)\s*\(|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(|@pytest\.mark\.skip|\bt\.Skip(?:Now|f)?\s*\(/;

export function isCommentLine(path: string, line: string): boolean {
  const t = line.trim();
  if (t.startsWith("//") || t.startsWith("/*") || /^\*(?:\s|\/|$)/.test(t))
    return true;
  return HASH_COMMENTS.test(path) && t.startsWith("#") && !t.startsWith("#!");
}

const asHunks = (added: ReadonlyMap<string, string[]>) =>
  new Map([...added].map(([path, ls]) => [path, [{ removed: [], added: ls }]]));

/**
 * Comment lines a change adds to code. Within a hunk, each comment line it
 * removes covers one it adds, so rewording a doc comment isn't a new one.
 */
function newComments(hunks: ReadonlyMap<string, readonly Hunk[]>) {
  const found: { path: string; line: string }[] = [];
  for (const [path, list] of hunks) {
    if (!CODE.test(path)) continue;
    for (const hunk of list) {
      let replaced = hunk.removed.filter((l) => isCommentLine(path, l)).length;
      for (const line of hunk.added) {
        if (!isCommentLine(path, line)) continue;
        if (replaced > 0) replaced--;
        else found.push({ path, line });
      }
    }
  }
  return found;
}

const where = (hits: string[]) =>
  `${hits.slice(0, 5).join("; ")}${hits.length > 5 ? `; and ${hits.length - 5} more` : ""}`;

function outcome(
  rule: (typeof DIFF_RULES)[number],
  hits: string[] | null,
  why: string,
): CheckOutcome {
  if (hits === null)
    return {
      id: rule.id,
      title: rule.title,
      base: "n/a",
      head: "n/a",
      outcome: "n/a",
      message: why,
    };
  return {
    id: rule.id,
    title: rule.title,
    base: "n/a",
    head: hits.length > 0 ? "red" : "green",
    outcome: hits.length > 0 ? "fail" : "pass",
    message: hits.length > 0 ? `${why}: ${where(hits)}` : "",
  };
}

export function diffRules(
  diff: readonly DiffEntry[],
  added: ReadonlyMap<string, string[]>,
  options: DiffRuleOptions,
): CheckOutcome[] {
  const [comments, markdown, suppressions] = DIFF_RULES;
  const lines = [...added].flatMap(([path, ls]) =>
    ls.map((line) => ({ path, line })),
  );

  const commentHits = options.noNewComments
    ? newComments(options.hunks ?? asHunks(added)).map(
        ({ path, line }) => `${path}: ${line.trim().slice(0, 80)}`,
      )
    : null;

  const named = options.card
    ? picomatch(
        options.card.touches.length > 0 ? options.card.touches : ["\0"],
        {
          dot: true,
        },
      )
    : null;
  const markdownHits = named
    ? diff
        .filter(
          (e) => e.status !== "D" && MARKDOWN.test(e.path) && !named(e.path),
        )
        .map((e) => e.path)
    : null;

  const suppressionHits = lines
    .filter(({ path }) => !options.allowedSuppressions?.has(path))
    .filter(({ line }) => SUPPRESSION.test(line) || SKIPPED_TEST.test(line))
    .map(({ path, line }) => `${path}: ${line.trim().slice(0, 80)}`);

  return [
    outcome(
      comments,
      commentHits,
      commentHits === null
        ? "off for this repo (profile quality.no-new-comments)"
        : "new comments",
    ),
    outcome(
      markdown,
      markdownHits,
      markdownHits === null
        ? "no task card to check against"
        : "Markdown the card doesn't name",
    ),
    outcome(suppressions, suppressionHits, "new suppressions or skipped tests"),
  ];
}
