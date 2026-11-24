// Intake's check of a card against the repo's own rules. A criterion the
// profile makes impossible (a code comment under quality.no-new-comments, a
// construct a banned pattern forbids) would only surface at the judge, after a
// whole build round was paid for, so intake refuses the card instead. One that
// needs a person later (a protected path, an existing test) is drafted, with
// the reason said up front.
import { buildContext } from "@arynbht/rivetari-engine";
import picomatch from "picomatch";

import { loadBanned } from "../judge/banned.js";
import { isCodePath } from "../judge/diff-rules.js";
import { isTestFile, PROTECTED } from "../judge/protected.js";
import type { Card } from "./card.js";
import { trackedFiles } from "./touches.js";

export interface ProfileConflicts {
  /** Criteria the profile makes impossible to meet: intake refuses the card. */
  refuse: string[];
  /** What a person will be asked about later: the card is drafted, with these said. */
  warn: string[];
}

const COMMENT_WORD = /\b(?:comments?|commented|jsdoc|tsdoc|docstrings?)\b/gi;

interface Negation {
  /** Words just before a mention that say it isn't wanted. */
  before: RegExp;
  /** Words just after it that say the same. */
  after: RegExp;
}

// "no new comments", "without a comment", "the stale JSDoc line at
// scores.ts:62 is removed": none of them asks for what it names.
const NOT_ASKED_FOR: Negation = {
  before:
    /\b(?:no|not|without|never|nor|zero|none|remove[sd]?|removing|delete[sd]?|deleting|strip(?:s|ped)?)\b/i,
  after:
    /^\W*(?:\w+\W+){0,6}?(?:unchanged|untouched|stays?|kept|remains?|intact|removed|deleted)\b/i,
};
// "no change to src/a.test.ts", "src/a.test.ts passes unchanged". Removing a
// protected file is still changing it, so removal words don't count here.
const NOT_A_CHANGE: Negation = {
  before: /\b(?:no|not|without|never|nor|don't|doesn't)\b/i,
  after:
    /^\W*(?:\w+\W+){0,6}?(?:unchanged|untouched|stays?|kept|remains?|intact)\b/i,
};
// A criterion names most files as references ("the same wait as
// .rivetari/proof-auth.mjs"); only one it says to change is worth a warning.
const CHANGE_BEFORE =
  /\b(?:edit|change|modify|modifies|update|add|write|rewrite|delete|remove|rename|move|bump|extend)(?:s|es|ed|d)?\b/i;

const wordsBefore = (text: string, at: number) =>
  text.slice(0, at).trim().split(/\s+/).slice(-5).join(" ");

function negated(
  text: string,
  at: number,
  length: number,
  negation: Negation,
): boolean {
  return (
    negation.before.test(wordsBefore(text, at)) ||
    negation.after.test(text.slice(at + length, at + length + 80))
  );
}

/** File names a criterion mentions, with where each one is in the text. */
function namedFiles(text: string): { path: string; at: number }[] {
  const found: { path: string; at: number }[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    const token = m[0].replace(/^[`'"([]+|[`'"),.;:\]]+$/g, "");
    if (!token || /[=()<>{}[\]]/.test(token) || /^[a-z]+:\/\//i.test(token))
      continue;
    // A file has an extension of two characters or more ("e.g." doesn't).
    if (/(?:^|\/)\.?[\w@*-]+(?:\.[\w*-]+)*\.[A-Za-z][\w-]+$/.test(token))
      found.push({ path: token, at: m.index });
  }
  return found;
}

const PROTECTED_GROUPS: [string, readonly string[]][] = [
  ["Rivetari's own state", PROTECTED.rivetariState],
  ["the skill registry", PROTECTED.skillRegistry],
  ["agent harness settings", PROTECTED.agentConfig],
  ["lint, format or type-check configuration", PROTECTED.lintConfig],
  ["CI or git hook configuration", PROTECTED.ciConfig],
];

function protectedGroup(path: string): string | undefined {
  return PROTECTED_GROUPS.find(([, globs]) =>
    picomatch([...globs], { dot: true })(path),
  )?.[0];
}

/** Where a card asks for what the repo's profile, banned list or protected paths rule out. */
export async function profileConflicts(
  repoPath: string,
  card: Pick<Card, "acceptance" | "touches">,
): Promise<ProfileConflicts> {
  const refuse: string[] = [];
  const warn: string[] = [];
  const profile = await buildContext(repoPath)
    .profile()
    .catch(() => null);
  const banned = await loadBanned(repoPath).catch(() => null);
  const tracked = new Set(await trackedFiles(repoPath).catch(() => []));

  for (const a of card.acceptance) {
    const files = namedFiles(a.text);
    if (profile?.quality?.["no-new-comments"]) {
      // The rule reads code only, so a commented line in .env.example or a
      // README isn't a breach of it.
      const named = files.map((f) => f.path);
      const asked = [...a.text.matchAll(COMMENT_WORD)].find(
        (m) => !negated(a.text, m.index, m[0].length, NOT_ASKED_FOR),
      );
      if (asked && (named.length === 0 || named.some(isCodePath)))
        refuse.push(
          `acceptance ${a.id} asks for a code comment ("${asked[0]}"), but the profile sets quality.no-new-comments, so the judge fails any new comment in code; say where the text goes instead (exported data, a README the card names), or turn the rule off in .rivetari/profile.yml`,
        );
    }
    for (const p of banned?.patterns ?? []) {
      const hit = new RegExp(p.pattern).exec(a.text);
      if (!hit || negated(a.text, hit.index, hit[0].length, NOT_ASKED_FOR))
        continue;
      const inScope = picomatch(p.files, { dot: true });
      const allowed = picomatch(p.allow.length > 0 ? p.allow : ["\0"], {
        dot: true,
      });
      if (
        files.length > 0 &&
        !files.some((f) => inScope(f.path) && !allowed(f.path))
      )
        continue;
      refuse.push(
        `acceptance ${a.id} asks for \`${hit[0]}\`, which the banned pattern ${p.id} forbids (${p.why}); reword it, or change .rivetari/banned.json`,
      );
    }
    for (const f of files) {
      if (
        !CHANGE_BEFORE.test(wordsBefore(a.text, f.at)) ||
        negated(a.text, f.at, f.path.length, NOT_A_CHANGE)
      )
        continue;
      const group = protectedGroup(f.path);
      if (group)
        warn.push(
          `acceptance ${a.id} names ${f.path}, a protected path (${group}): the build stops to ask a person before it changes, and the judge marks the change as needing one`,
        );
      else if (isTestFile(f.path) && tracked.has(f.path))
        warn.push(
          `acceptance ${a.id} names ${f.path}, a test that already exists: changing it needs a person; a new test is the usual way`,
        );
    }
  }
  for (const t of card.touches) {
    const group = protectedGroup(t);
    if (group)
      warn.push(
        `touches names ${t}, a protected path (${group}): the build stops to ask a person before it changes, and the judge marks the change as needing one`,
      );
  }
  return { refuse, warn };
}
