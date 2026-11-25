// Judge tier 2: a scoped AI review of a change.
//
// Exactly three kinds of finding may block — a defect, a contract breach
// (AGENTS.md / CONSTRAINTS.md), or an unmet acceptance criterion. Anything
// else is a suggestion: collected, never a reason to request changes. Every
// blocking finding is re-checked in a fresh context for a concrete
// reproduction; without one it's downgraded to a suggestion.
//
// The model sees only what this module packs into the prompt: the diff (minus
// sensitive paths and anything secret-shaped), the contract files from the
// base commit, the files changed docs cite, and the task's proof when the
// judge beat passes it. The CLI transport runs locked down (no tools, empty
// cwd).
import { createHash } from "node:crypto";

import {
  type AiClient,
  appendUsage,
  type Effort,
  estimateCost,
  isSensitivePath,
  looksLikeSecret,
} from "@arynbht/rivetari-engine";
import picomatch from "picomatch";
import { type SimpleGit, simpleGit } from "simple-git";
import { z } from "zod";

import type { Shot } from "../proof/shoot.js";
import type { Card } from "../task/card.js";
import type { AllowedDecision } from "../task/tasks.js";
import { bannedSection, loadBanned } from "./banned.js";
import {
  applyBaseTests,
  type BaseTests,
  baseTestsSection,
} from "./base-tests.js";
import { isTestFile, parseNameStatus } from "./protected.js";
import {
  type Tier1Checks,
  tier1Section,
  tier1Status,
} from "./tier1-criteria.js";

export const BLOCKING_KINDS = ["defect", "contract", "acceptance"] as const;
export const FINDING_KINDS = [...BLOCKING_KINDS, "suggestion"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** Default judge model, deliberately not the drafting default (independence). */
export const JUDGE_DEFAULT_MODEL = "claude-opus-5-5";
/** Max characters of diff packed into the prompt (~100k tokens). */
const DIFF_BUDGET = 400_000;
/**
 * A test file's diff past this many characters is sent as its first part and
 * the names of the tests in the rest. Large test diffs are mostly fixtures and
 * golden rows; the review needs their shape and what they assert, not every
 * row, and a criterion they leave unshown comes back unverified for a person.
 */
export const TEST_FILE_CAP = 12_000;
/** Test diff sent in full across all files before every further one is cut too. */
export const TEST_TOTAL_CAP = 60_000;
/**
 * The diff a finding with no file is checked against. The gate re-reads the
 * whole change otherwise, once per finding, which multiplied a big review's
 * cost by its findings.
 */
export const GATE_DIFF_CAP = 60_000;

/** Machine-written files: reviewing them wastes the budget and finds nothing. */
const GENERATED = picomatch(
  [
    "**/dist/**",
    "**/*.min.js",
    "**/*.map",
    "**/pnpm-lock.yaml",
    "**/package-lock.json",
    "**/yarn.lock",
    "**/bun.lock",
    "**/bun.lockb",
    "**/Cargo.lock",
    "**/poetry.lock",
    "**/uv.lock",
    "**/go.sum",
  ],
  { dot: true },
);

export const isGeneratedPath = (path: string): boolean => GENERATED(path);

/**
 * Which of `paths` are machine-written: the paths above, plus the files the
 * repo marks as generated (`linguist-generated` in .gitattributes).
 */
export async function generatedPaths(
  git: SimpleGit,
  paths: readonly string[],
): Promise<Set<string>> {
  const generated = new Set(paths.filter((p) => GENERATED(p)));
  if (paths.length === 0) return generated;
  const attrs = await git
    .raw(["check-attr", "linguist-generated", "--", ...paths])
    .catch(() => "");
  for (const line of attrs.split("\n")) {
    const m = /^(.*): linguist-generated: (set|true)$/.exec(line.trim());
    if (m?.[1]) generated.add(m[1]);
  }
  return generated;
}

/** Review order when the budget is tight: source, then tests, then docs and config. */
function priority(path: string): number {
  if (isTestFile(path)) return 1;
  if (/\.(md|mdx|txt|ya?ml|json|toml|lock)$/i.test(path)) return 2;
  return 0;
}
/** Max blocking findings sent to the false-positive gate. */
const MAX_FP_CHECKS = 8;

/** Optional text the model may send as null or leave out: both mean none. */
const optionalText = () =>
  z
    .string()
    .nullish()
    .transform((v) => v ?? "");

const FindingSchema = z.object({
  kind: z.enum(FINDING_KINDS).catch("suggestion"),
  file: optionalText(),
  // A bad line or a missing title shouldn't throw away the whole review.
  line: z.number().int().nonnegative().nullable().default(null).catch(null),
  acceptance_id: z.string().nullable().optional(),
  title: z.string().min(1).catch("(untitled)"),
  detail: optionalText(),
  repro: optionalText(),
  fix: optionalText(),
});
export type Finding = z.infer<typeof FindingSchema> & {
  /** Set when the false-positive gate turned a blocking finding into a suggestion. */
  downgraded?: string | undefined;
  pattern?: string | undefined;
};

export function findingPattern(kind: string, message: string): string {
  const normal = message
    .toLowerCase()
    .replace(/`[^`]*`/g, " x ")
    .replace(/"[^"]*"|'[^']*'/g, " x ")
    .replace(/[\w./-]+\.[a-z]{1,5}(?::\d+)?/g, " file ")
    .replace(/\d+/g, " n ")
    .replace(/[^a-z ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256")
    .update(`${kind}\0${normal}`)
    .digest("hex")
    .slice(0, 12);
}

const ReviewSchema = z.object({
  findings: z.array(FindingSchema).default([]),
  acceptance: z
    .array(
      z.object({
        id: z.string(),
        status: z.enum(["met", "unmet", "unverified"]).catch("unverified"),
        note: optionalText(),
      }),
    )
    .default([]),
  /** Asked only on a fix card with a UI proof: does the "before" show the defect? */
  before: z
    .object({
      // Anything but a plain yes means the before doesn't show it.
      shows_defect: z.boolean().catch(false),
      note: optionalText(),
      criteria: z.array(z.string()).catch([]).default([]),
    })
    .nullish()
    .catch(null),
});

export type BeforeCheck = NonNullable<z.infer<typeof ReviewSchema>["before"]>;

const GateSchema = z.object({
  reproducible: z.boolean(),
  repro: optionalText(),
  reason: optionalText(),
});

export interface PackedChange {
  diff: string;
  files: string[];
  /** `stats` is the file's added and removed line counts, when git has them. */
  omitted: { path: string; why: string; stats?: string | undefined }[];
  /** Test files sent only in part, and how much of each was left out. */
  trimmed?: { path: string; note: string }[] | undefined;
  /** New-side line numbers that appear in the diff, per file (for inline comments). */
  lines: Map<string, Set<number>>;
  agents: string | null;
  constraints: string | null;
  banned?: string | null | undefined;
  /** Repo files the changed Markdown cites, at head, so citations can be checked. */
  cited?: CitedFile[] | undefined;
}

export interface CitedFile {
  path: string;
  /** The file at head, cut at the per-file cap; null when over the total cap. */
  text: string | null;
  truncated: boolean;
}

export interface Tier2Result {
  verdict: "approve" | "request-changes";
  blocking: Finding[];
  suggestions: Finding[];
  acceptance: z.infer<typeof ReviewSchema>["acceptance"];
  /** The reviewer's answer on a fix card's "before" proof, when it was asked. */
  before?: BeforeCheck | undefined;
  /**
   * Changed files the reviewer wasn't shown for a reason other than being
   * generated (sensitive, secret-shaped, binary, over budget). A change with
   * any can't be approved by the judge: a person looks at them.
   */
  unreviewed: string[];
  /**
   * The card's criteria nobody confirmed: marked unverified, or not reported
   * at all. Set when there's a card; a change with any can't be approved
   * without a person.
   */
  unverified?: { id: string; note: string }[] | undefined;
  model: string;
  /** The effort the review ran at, when one was set. */
  effort?: Effort | undefined;
  calls: number;
  /** Tokens and estimated cost across every call. */
  usage: { tokens: number; costUsd: number };
  packed: Omit<PackedChange, "diff">;
}

/**
 * The parts of a task's proof record (`proof/proof.json`) the reviewer is
 * shown. Its own type, not the prove beat's: prove imports tier 1, which
 * imports this module.
 */
export interface ReviewProof {
  kind: string;
  passed: boolean;
  lines: string[];
  shots?: (Shot & { side: "before" | "after" })[] | undefined;
  tests?: { exitCode: number; added: string[]; output: string } | undefined;
}

export interface Tier2Options {
  repoPath: string;
  /** The merge-base (or base commit) and the change's head commit. */
  base: string;
  head: string;
  ai: AiClient;
  model?: string | undefined;
  card?: Card | undefined;
  decisions?: readonly AllowedDecision[] | undefined;
  /** The task's proof record, so criteria can be checked against it. */
  proof?: ReviewProof | undefined;
  /** Tier 1's checks on the same change, this round: shown, and settling criteria about them. */
  tier1?: Tier1Checks | undefined;
  /** Tier 1's run of the change's new tests on the base, this round. */
  baseTests?: BaseTests | undefined;
  /** How hard the reviewer thinks (the CLI's `--effort`); its default when unset. */
  effort?: Effort | undefined;
  /** YYYY-MM-DD for the usage log; no log when omitted. */
  usageDate?: string | undefined;
  log?: ((line: string) => void) | undefined;
}

/**
 * The card's criteria the reviewer didn't confirm: marked unverified, or not
 * reported at all (silence isn't a verification).
 */
export function unverifiedCriteria(
  card: Pick<Card, "acceptance">,
  acceptance: Tier2Result["acceptance"],
): { id: string; note: string }[] {
  return card.acceptance.flatMap((c) => {
    const a = acceptance.find((r) => r.id === c.id);
    if (!a) return [{ id: c.id, note: "the reviewer didn't report on it" }];
    return a.status === "unverified"
      ? [{ id: c.id, note: a.note || "no reason given" }]
      : [];
  });
}

function decisionsSection(
  decisions: readonly AllowedDecision[] | undefined,
): string[] {
  const allowed = decisions?.filter((d) => !d.flagged) ?? [];
  const flagged = decisions?.filter((d) => d.flagged) ?? [];
  return [
    ...(allowed.length > 0
      ? [
          `## Decisions a person already made\nA person was asked about each of these and allowed it. Do not block on a change a person allowed: it is not a defect, a contract breach or an unmet criterion because of what was allowed.\n${allowed.map((d) => `- ${d.asked} — allowed by ${d.by} at ${d.at}${d.note ? `: ${d.note}` : ""}`).join("\n")}`,
        ]
      : []),
    ...(flagged.length > 0
      ? [
          `## Decisions flagged for the person reviewing the PR\nThe repo's autonomy level let the build go on without asking about these; the PR lists each one for a person to decide at merge. Do not block only because nobody was asked. Judge the change itself as usual.\n${flagged.map((d) => `- ${d.asked} — flagged at ${d.at}`).join("\n")}`,
        ]
      : []),
  ];
}

async function showAt(git: SimpleGit, rev: string, path: string) {
  try {
    return await git.show([`${rev}:${path}`]);
  } catch {
    return null;
  }
}

/**
 * The change as the reviewer sees it. Files at sensitive paths, or whose added
 * lines look like they hold a secret, are left out (and listed, so the review
 * says what it didn't see). The contract files come from the base commit: the
 * change can't rewrite the rules it's judged by.
 */
export async function packChange(
  repoPath: string,
  base: string,
  head: string,
): Promise<PackedChange> {
  const git = simpleGit(repoPath);
  const all = parseNameStatus(
    await git.raw(["diff", "--name-status", "-M", base, head]),
  );
  const generated = await generatedPaths(
    git,
    all.map((e) => e.path),
  );
  const entries = all
    .map((entry, i) => ({ entry, i }))
    .sort(
      (a, b) => priority(a.entry.path) - priority(b.entry.path) || a.i - b.i,
    )
    .map(({ entry }) => entry);
  const omitted: PackedChange["omitted"] = [];
  const trimmed: NonNullable<PackedChange["trimmed"]> = [];
  const files: string[] = [];
  const lines = new Map<string, Set<number>>();
  let diff = "";
  let testChars = 0;
  for (const entry of entries) {
    if (isSensitivePath(entry.path)) {
      omitted.push({ path: entry.path, why: "sensitive path" });
      continue;
    }
    if (generated.has(entry.path)) {
      // Counts, not text: a lockfile's churn says how big a dependency change
      // is without spending the budget on it.
      const stats = await numstat(git, base, head, entry.path);
      omitted.push({
        path: entry.path,
        why: "generated",
        ...(stats ? { stats } : {}),
      });
      continue;
    }
    const fileDiff = await git.raw([
      "diff",
      "-U5",
      "--no-color",
      "-M",
      base,
      head,
      "--",
      ...(entry.oldPath ? [entry.oldPath] : []),
      entry.path,
    ]);
    if (/^Binary files /m.test(fileDiff)) {
      omitted.push({ path: entry.path, why: "binary" });
      continue;
    }
    // Every body line is sent (removed and context lines too), so scan them all.
    const body = fileDiff
      .split("\n")
      .filter((l) => /^[+\- ]/.test(l) && !/^(\+\+\+|---) /.test(l))
      .join("\n");
    if (looksLikeSecret(body)) {
      omitted.push({ path: entry.path, why: "looks like it holds a secret" });
      continue;
    }
    let sent = fileDiff;
    if (isTestFile(entry.path)) {
      const allowance = Math.max(
        TEST_FILE_CAP / 6,
        Math.min(TEST_FILE_CAP, TEST_TOTAL_CAP - testChars),
      );
      if (fileDiff.length > allowance) {
        const cut = trimTestDiff(fileDiff, allowance);
        sent = cut.diff;
        trimmed.push({ path: entry.path, note: cut.note });
      }
      testChars += sent.length;
    }
    if (diff.length + sent.length > DIFF_BUDGET) {
      omitted.push({ path: entry.path, why: "over the review's size budget" });
      continue;
    }
    diff += sent;
    files.push(entry.path);
    lines.set(entry.path, newSideLines(sent));
  }
  const docs = files.filter((f) => MARKDOWN.test(f));
  return {
    diff,
    files,
    omitted,
    ...(trimmed.length > 0 ? { trimmed } : {}),
    lines,
    agents: await showAt(git, base, "AGENTS.md"),
    constraints: await showAt(git, base, "CONSTRAINTS.md"),
    banned: bannedSection(await loadBanned(repoPath, base)).join("\n") || null,
    ...(docs.length > 0
      ? { cited: await citedFiles(git, head, docs, diff) }
      : {}),
  };
}

/** A file's "+added −removed" from git, or null when git can't count it. */
async function numstat(
  git: SimpleGit,
  base: string,
  head: string,
  path: string,
): Promise<string | null> {
  const out = await git
    .raw(["diff", "--numstat", "--no-renames", base, head, "--", path])
    .catch(() => "");
  const m = /^(\d+)\t(\d+)\t/.exec(out);
  return m ? `+${m[1]} −${m[2]} lines` : null;
}

const TEST_NAME = /\b(?:it|test|describe)(?:\.\w+)?\(\s*(["'`])(.+?)\1/;
/** How many cut-off test names the note lists. */
const MAX_TEST_NAMES = 40;

/**
 * A test file's diff cut at a line boundary near `allowance` characters, and
 * a note naming the tests in the part left out, so the reviewer knows what
 * exists even where it can't read the body.
 */
export function trimTestDiff(
  fileDiff: string,
  allowance: number,
): { diff: string; note: string } {
  const end = fileDiff.lastIndexOf("\n", allowance);
  const kept = fileDiff.slice(0, end > 0 ? end + 1 : allowance);
  const rest = fileDiff.slice(kept.length).split("\n").filter(Boolean);
  const names = rest
    .filter((l) => l.startsWith("+"))
    .flatMap((l) => {
      const name = TEST_NAME.exec(l)?.[2];
      return name ? [name] : [];
    });
  const shown = names.slice(0, MAX_TEST_NAMES);
  const note = `first ${kept.length} of ${fileDiff.length} characters; ${rest.length} more line(s) not shown${shown.length > 0 ? `; tests in them: ${shown.map((n) => JSON.stringify(n)).join(", ")}${names.length > shown.length ? ` and ${names.length - shown.length} more` : ""}` : ""}`;
  return { diff: `${kept}… (trimmed: ${note})\n`, note };
}

const MARKDOWN = /\.(md|mdx)$/i;
/** Caps on what changed docs bring along: per file, in all, and how many files. */
export const CITED_FILE_CAP = 20_000;
export const CITED_TOTAL_CAP = 60_000;
const CITED_MAX_FILES = 20;

/**
 * The repo files the added lines of changed Markdown cite in backticks
 * (`src/a.ts`, `src/a.ts:12`), at head. Only files that exist there, never a
 * sensitive, generated, binary or secret-shaped one, and within the caps: a
 * doc's claims about code can't be checked from the doc's own diff.
 */
export async function citedFiles(
  git: SimpleGit,
  head: string,
  docs: readonly string[],
  diff: string,
): Promise<CitedFile[]> {
  const tracked = new Set(
    (await git.raw(["ls-tree", "-r", "--name-only", head]).catch(() => ""))
      .split("\n")
      .filter(Boolean),
  );
  const wanted: string[] = [];
  for (const chunk of diff.split(/^(?=diff --git )/m)) {
    const doc = docs.find((d) => chunk.includes(` b/${d}\n`));
    if (!doc) continue;
    const added = chunk
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++ "))
      .join("\n");
    for (const m of added.matchAll(/`([^`\s]+)`/g)) {
      const path = (m[1] ?? "")
        .replace(/^\.\//, "")
        .replace(/(#L\d.*|:\d+(-\d+)?)$/, "");
      if (path !== doc && tracked.has(path) && !wanted.includes(path))
        wanted.push(path);
    }
  }
  const generated = await generatedPaths(git, wanted);
  const out: CitedFile[] = [];
  let total = 0;
  for (const path of wanted) {
    if (out.length >= CITED_MAX_FILES) break;
    if (isSensitivePath(path) || generated.has(path)) continue;
    const text = await showAt(git, head, path);
    if (text === null || text.includes("\0") || looksLikeSecret(text)) continue;
    const truncated = text.length > CITED_FILE_CAP;
    const kept = truncated ? text.slice(0, CITED_FILE_CAP) : text;
    if (total + kept.length > CITED_TOTAL_CAP) {
      out.push({ path, text: null, truncated: false });
      continue;
    }
    total += kept.length;
    out.push({ path, text: kept, truncated });
  }
  return out;
}

/** New-side line numbers covered by a file's hunks (added and context lines). */
export function newSideLines(fileDiff: string): Set<number> {
  const out = new Set<number>();
  let line = 0;
  let inHunk = false;
  for (const text of fileDiff.split("\n")) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (hunk) {
      line = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || text.startsWith("\\")) continue;
    if (text.startsWith("-")) continue;
    if (text.startsWith("+") || text.startsWith(" ")) out.add(line++);
  }
  return out;
}

const RUBRIC = `You are the judge in a Rivetari, reviewing one change (a diff) before a human merges it.

You may raise exactly three kinds of BLOCKING finding:
- "defect": a correctness bug, security issue, data loss, race, or unhandled failure path that this diff introduces or leaves reachable.
- "contract": the diff violates AGENTS.md, CONSTRAINTS.md, or a stated house pattern (quote the rule).
- "acceptance": an acceptance criterion on the task card is unmet by this change (give its id).

For every acceptance criterion on the card, report one status:
- "met": the evidence shows it is met: the diff, a test in the diff that actually exercises it, or the proof given below.
- "unmet": the evidence shows it is not met.
- "unverified": you can't confirm it from the evidence. Use this rather than guessing "met": a manual or screenshot criterion the proof doesn't show, a test that doesn't really exercise the criterion, a claim about code you weren't shown. Say in the note what is missing. An unverified criterion isn't a finding; a person decides it.

Everything else — style, naming, readability, "could be tighter", alternative designs, missing nice-to-haves, speculative risks — is a "suggestion". Suggestions never block.

Rules:
- Every blocking finding needs a concrete "repro": the input, state or steps that make the problem happen in THIS diff. If you can't write one, it is a suggestion.
- "line" is the line number in the new version of the file, from the diff's hunk headers. Use null if no single line applies.
- Don't report problems in code the diff didn't touch unless the diff makes them reachable.
- Be specific and brief. No praise, no summary of the change.

Reply with ONLY a JSON object, no prose and no code fence:
{"findings":[{"kind":"defect|contract|acceptance|suggestion","file":"path","line":12,"acceptance_id":"A1 or null","title":"one line","detail":"what is wrong and why","repro":"how to trigger it","fix":"the smallest change that fixes it"}],"acceptance":[{"id":"A1","status":"met|unmet|unverified","note":"short"}],"before":null}

Only when the prompt has a section headed "The before proof", replace null with {"shows_defect":true|false,"note":"what the before evidence shows","criteria":["ids whose verification depends on the before showing the defect"]}.`;

const GATE = `You are checking one code-review finding before it can block a merge. Default to rejecting it.

Decide whether the finding is real and reproducible in THIS diff, and how. It is reproducible only if you can name concrete inputs, state or steps that trigger the problem given the code shown. Style, preference and speculative concerns are not reproducible.

A contract finding must break a rule quoted from the contract given below; a rule that isn't in the text given doesn't exist. An acceptance finding must leave a criterion unmet: every criterion on the task card is listed below, in full, whatever the finding's kind. When the prompt says there is no task card, judge a finding that names a criterion on the code alone: don't reject it because the criterion's text isn't shown.

Reply with ONLY a JSON object: {"reproducible": true|false, "repro": "exact steps, or empty", "reason": "one line"}`;

/** A fix card proved with screenshots: its "before" has to show the defect. */
export const needsBeforeCheck = (card?: Card, proof?: ReviewProof): boolean =>
  card?.type === "fix" && proof?.kind === "ui-screenshots";

function shotLine(shot: NonNullable<ReviewProof["shots"]>[number]): string {
  const where = `${shot.side} · ${shot.page} at ${shot.breakpoint} · HTTP ${shot.status} · ${shot.file.replace(/\\/g, "/").split("/").pop() ?? ""}`;
  // Whether the page rendered, and the image's size, go last: a shot of a
  // loading state reads as one, and a skeleton is far smaller than the page.
  const rendered = `${
    shot.ready === false
      ? ` · NOT RENDERED, the image is of the loading state: ${shot.notReady ?? "it never settled"}`
      : ""
  }${shot.bytes !== undefined ? ` · ${shot.bytes} bytes` : ""}`;
  const l = shot.layout;
  if (!l) return `- ${where} · nothing measured${rendered}`;
  const overflow =
    l.scrollWidth > l.viewport
      ? `scrolls sideways: ${l.scrollWidth}px of content in a ${l.viewport}px viewport`
      : `no sideways scroll (${l.scrollWidth}px in a ${l.viewport}px viewport)`;
  const past =
    l.overflowing.length > 0
      ? `elements past the viewport's edge: ${l.overflowing.join("; ")}`
      : "no element past the viewport's edge";
  return `- ${where} · ${overflow} · ${past}${l.text ? ` · text starts: ${JSON.stringify(l.text)}` : ""}${rendered}`;
}

/** Proof text goes to the model like the diff does: never secret-shaped. */
const unlessSecret = (text: string) =>
  looksLikeSecret(text) ? "(left out: looks like it holds a secret)" : text;

function proofSection(proof: ReviewProof, card?: Card): string[] {
  const parts = [
    `## The proof\nProduced by a tool on the change, never written by the agent. Kind: ${proof.kind} · ${proof.passed ? "passed" : "failed"}.\n${proof.lines.map((l) => `- ${unlessSecret(l)}`).join("\n")}`,
  ];
  if (proof.tests) {
    parts.push(
      `### Test run\nExit ${proof.tests.exitCode} · new tests: ${proof.tests.added.join("; ") || "none"}\n\`\`\`\n${unlessSecret(proof.tests.output.slice(-3000))}\n\`\`\``,
    );
  }
  if (proof.shots?.length) {
    parts.push(
      `### Screenshots\nYou can't see the images. For each one you have its side (before = the base, after = the change), page, breakpoint (sm 375px, md 768px, lg 1280px wide, w<n> n px wide), HTTP status, and what the proof runner measured on the page.\n${proof.shots.map(shotLine).join("\n")}`,
    );
  }
  if (needsBeforeCheck(card, proof)) {
    parts.push(
      `## The before proof\nThis card is a fix, so its before screenshots (the base, before the change) must show the defect the card describes, or the proof shows nothing was fixed. Judge from what was measured on the before shots above, and answer in "before". If the before evidence doesn't show the defect, every criterion that depends on it is "unverified", not "met".`,
    );
  }
  return parts;
}

function citedSection(cited: readonly CitedFile[]): string[] {
  if (cited.length === 0) return [];
  return [
    `## Files the changed docs cite\nThe changed Markdown cites these repo files; here they are at the change's head. Check that what the docs say about them is true.\n\n${cited
      .map((c) =>
        c.text === null
          ? `### ${c.path}\n(not shown: over the review's size cap for cited files)`
          : `### ${c.path}${c.truncated ? ` (first ${CITED_FILE_CAP} characters)` : ""}\n\`\`\`\n${c.text}\n\`\`\``,
      )
      .join("\n\n")}`,
  ];
}

function reviewPrompt(
  packed: PackedChange,
  card?: Card,
  decisions?: readonly AllowedDecision[],
  proof?: ReviewProof,
  tier1?: Tier1Checks,
  baseTests?: BaseTests,
): string {
  const parts: string[] = [];
  if (card) {
    parts.push(
      `## Task card ${card.id}: ${card.title}\n${card.description}\n\nAcceptance criteria:\n${criteriaLines(card)}` +
        (card.out_of_scope.length
          ? `\n\nOut of scope:\n${card.out_of_scope.map((o) => `- ${o}`).join("\n")}`
          : "") +
        (card.constraints.length
          ? `\n\nConstraints:\n${card.constraints.map((c) => `- ${c}`).join("\n")}`
          : ""),
    );
  }
  if (packed.agents)
    parts.push(`## AGENTS.md (the repo's contract)\n${packed.agents}`);
  if (packed.constraints)
    parts.push(`## CONSTRAINTS.md\n${packed.constraints}`);
  if (packed.banned) parts.push(packed.banned);
  parts.push(...decisionsSection(decisions));
  if (packed.omitted.length) {
    parts.push(
      `## Not shown to you\n${packed.omitted.map((o) => `- ${o.path}: ${o.why}${o.stats ? ` (${o.stats})` : ""}`).join("\n")}`,
    );
  }
  if (packed.trimmed?.length) {
    parts.push(
      `## Test files shown in part\nThese are cut to keep the review's size down; a criterion that rests on the part not shown is unverified, not met.\n${packed.trimmed.map((t) => `- ${t.path}: ${t.note}`).join("\n")}`,
    );
  }
  if (tier1) parts.push(...tier1Section(tier1));
  parts.push(...baseTestsSection(baseTests));
  if (proof) parts.push(...proofSection(proof, card));
  parts.push(...citedSection(packed.cited ?? []));
  parts.push(`## The diff\n${packed.diff || "(empty)"}`);
  return parts.join("\n\n");
}

/**
 * On a fix card proved with screenshots, a before the reviewer didn't say
 * shows the defect leaves every criterion that depends on it unverified (all
 * of them when it named none). An unmet criterion stays unmet.
 */
export function applyBeforeCheck(
  acceptance: Tier2Result["acceptance"],
  card: Card,
  before: BeforeCheck | null | undefined,
): Tier2Result["acceptance"] {
  if (before?.shows_defect === true) return acceptance;
  const ids = card.acceptance.map((a) => a.id);
  const named = (before?.criteria ?? []).filter((id) => ids.includes(id));
  const depends = new Set(named.length > 0 ? named : ids);
  const why = `the before proof doesn't show the defect${before?.note ? `: ${before.note}` : before ? "" : " (the reviewer didn't say it does)"}`;
  const out = acceptance.map((a) =>
    depends.has(a.id) && a.status === "met"
      ? { ...a, status: "unverified" as const, note: why }
      : a,
  );
  for (const id of depends)
    if (!out.some((a) => a.id === id))
      out.push({ id, status: "unverified", note: why });
  return out;
}

/** What the gate sees: the finding, the rules it cites, and its file's diff. */
function gatePrompt(
  finding: Finding,
  fileDiff: string,
  packed: PackedChange,
  card?: Card,
  decisions?: readonly AllowedDecision[],
): string {
  const parts = [
    `## Finding (${finding.kind})\n${JSON.stringify(finding, null, 2)}`,
    ...decisionsSection(decisions),
  ];
  if (finding.kind === "contract") {
    parts.push(
      `## AGENTS.md (the repo's contract)\n${packed.agents ?? "(none)"}`,
      `## CONSTRAINTS.md\n${packed.constraints ?? "(none)"}`,
      ...(packed.banned ? [packed.banned] : []),
    );
  }
  // Every finding, not only an acceptance one: a defect tied to a criterion
  // was rejected because "no A5 text is given" when the runtime hadn't sent it.
  parts.push(
    card
      ? `## Acceptance criteria (task card ${card.id}: ${card.title})\n${criteriaLines(card)}`
      : "## Acceptance criteria\nThere is no task card for this change: neither you nor the reviewer were given criteria.",
  );
  parts.push(
    `## The diff\n${fileDiff.length > GATE_DIFF_CAP ? `${fileDiff.slice(0, GATE_DIFF_CAP)}\n… (the rest of the diff isn't shown here)` : fileDiff}`,
  );
  return parts.join("\n\n");
}

const criteriaLines = (card: Pick<Card, "acceptance">) =>
  card.acceptance.map((a) => `- ${a.id} (${a.verify}): ${a.text}`).join("\n");

/** The last JSON object in a reply (models sometimes add text around it). */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidates = [fenced, text].filter((t): t is string => Boolean(t));
  for (const candidate of candidates) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) continue;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      // try the next candidate
    }
  }
  throw new Error("the reviewer did not reply with JSON");
}

/** An unmet criterion as a finding, so it blocks and shows like one. */
const unmetFinding = (id: string, note: string): Finding => ({
  kind: "acceptance",
  file: "",
  line: null,
  acceptance_id: id,
  title: `${id} is unmet`,
  detail: note,
  repro: note,
  fix: "",
});

/** Criteria that only say tier 1's checks pass take their status from tier 1. */
function applyTier1(
  acceptance: Tier2Result["acceptance"],
  card: Pick<Card, "acceptance">,
  checks: Tier1Checks,
): Tier2Result["acceptance"] {
  const out = [...acceptance];
  for (const c of card.acceptance) {
    const settled = tier1Status(c.text, checks);
    if (!settled) continue;
    const i = out.findIndex((a) => a.id === c.id);
    if (i === -1) out.push({ id: c.id, ...settled });
    else out[i] = { id: c.id, ...settled };
  }
  return out;
}

/**
 * Run the review: one call for findings, then one fresh-context call per
 * blocking finding (up to a cap) to confirm it reproduces. Findings that fail
 * the gate, or exceed the cap, become suggestions. A criterion marked unmet
 * blocks without the gate: the card says what done is, and the gate only
 * filters findings, so it can't turn "not done" into a suggestion.
 */
export async function runTier2(options: Tier2Options): Promise<Tier2Result> {
  const log = options.log ?? (() => undefined);
  const model = options.model ?? JUDGE_DEFAULT_MODEL;
  const card = options.card;
  const packed = await packChange(options.repoPath, options.base, options.head);
  let calls = 0;
  const usage = { tokens: 0, costUsd: 0 };
  const complete = async (system: string, prompt: string, task: string) => {
    calls++;
    const res = await options.ai.complete({
      system,
      prompt,
      model,
      maxTokens: 8000,
      ...(options.effort ? { effort: options.effort } : {}),
    });
    const cost = res.costUsd ?? estimateCost(res.model, res.usage);
    usage.tokens +=
      res.usage.inputTokens +
      res.usage.outputTokens +
      (res.usage.cacheCreationTokens ?? 0) +
      (res.usage.cacheReadTokens ?? 0);
    usage.costUsd += cost;
    if (options.usageDate) {
      await appendUsage(options.repoPath, {
        date: options.usageDate,
        task,
        model: res.model,
        inputTokens: res.usage.inputTokens,
        outputTokens: res.usage.outputTokens,
        costUsd: cost,
      }).catch(() => undefined);
    }
    return res.text;
  };
  const unreviewed = packed.omitted
    .filter((o) => o.why !== "generated")
    .map((o) => o.path);
  const packedOut: Tier2Result["packed"] = {
    files: packed.files,
    omitted: packed.omitted,
    ...(packed.trimmed ? { trimmed: packed.trimmed } : {}),
    lines: packed.lines,
    agents: packed.agents,
    constraints: packed.constraints,
  };
  const effort = options.effort ? { effort: options.effort } : {};

  // Nothing to read means nothing a card asks for can be met, and no call to
  // pay for. An empty change is unmet; one whose files were all held back
  // (generated, sensitive, secret-shaped) is unverified, for a person.
  if (card && packed.files.length === 0) {
    const empty = packed.omitted.length === 0;
    const note = empty
      ? "the change is empty: no file differs from the base"
      : `no file was shown to the reviewer: ${packed.omitted.map((o) => `${o.path} (${o.why})`).join(", ")}`;
    log(`reviewing 0 file(s): ${note}`);
    const acceptance = card.acceptance.map((a) => ({
      id: a.id,
      status: empty ? ("unmet" as const) : ("unverified" as const),
      note,
    }));
    const blocking = empty
      ? card.acceptance.map((a) => ({
          ...unmetFinding(a.id, note),
          pattern: findingPattern("acceptance", `${a.id} is unmet`),
        }))
      : [];
    return {
      verdict: blocking.length > 0 ? "request-changes" : "approve",
      blocking,
      suggestions: [],
      acceptance,
      unreviewed,
      unverified: unverifiedCriteria(card, acceptance),
      model,
      ...effort,
      calls,
      usage,
      packed: packedOut,
    };
  }

  log(
    `reviewing ${packed.files.length} file(s) with ${model}${options.effort ? ` at ${options.effort} effort` : ""}`,
  );
  const review = ReviewSchema.parse(
    extractJson(
      await complete(
        RUBRIC,
        reviewPrompt(
          packed,
          card,
          options.decisions,
          options.proof,
          options.tier1,
          options.baseTests,
        ),
        "judge-review",
      ),
    ),
  );
  const checkBefore = needsBeforeCheck(card, options.proof);
  let acceptance =
    checkBefore && card
      ? applyBeforeCheck(review.acceptance, card, review.before)
      : review.acceptance;
  if (card && options.tier1)
    acceptance = applyTier1(acceptance, card, options.tier1);
  // A test that passes without the change shows nothing is done, whatever
  // the reviewer read into it.
  if (card) acceptance = applyBaseTests(acceptance, card, options.baseTests);

  // An unmet criterion blocks like any acceptance finding, even when the
  // reviewer only marked it unmet.
  const cardIds = new Set(card?.acceptance.map((a) => a.id) ?? []);
  const unmetIds = new Set(
    acceptance
      .filter((a) => a.status === "unmet" && cardIds.has(a.id))
      .map((a) => a.id),
  );
  const cited = new Set(
    review.findings
      .filter((f) => f.kind === "acceptance" && f.acceptance_id)
      .map((f) => f.acceptance_id),
  );
  const unmet: Finding[] = [...unmetIds]
    .filter((id) => !cited.has(id))
    .map((id) =>
      unmetFinding(id, acceptance.find((a) => a.id === id)?.note ?? ""),
    );

  const blocking: Finding[] = [];
  const suggestions: Finding[] = [];
  let checked = 0;
  for (const found of [...review.findings, ...unmet]) {
    const finding = {
      ...found,
      pattern: findingPattern(found.kind, found.title),
    };
    if (finding.kind === "suggestion") {
      suggestions.push(finding);
      continue;
    }
    // Not through the gate, the file check or the budget: those filter false
    // positives, and an unmet criterion isn't one. The pilot's empty diff
    // passed when each unmet criterion was downgraded for naming a file the
    // change didn't have.
    if (
      finding.kind === "acceptance" &&
      finding.acceptance_id &&
      unmetIds.has(finding.acceptance_id)
    ) {
      blocking.push(finding);
      continue;
    }
    // A finding about a file the reviewer wasn't shown can't be confirmed.
    if (finding.file && !packed.files.includes(finding.file)) {
      suggestions.push({
        ...finding,
        kind: "suggestion",
        downgraded: "names a file outside the diff",
      });
      continue;
    }
    if (checked >= MAX_FP_CHECKS) {
      suggestions.push({
        ...finding,
        kind: "suggestion",
        downgraded: "over the review's check budget",
      });
      continue;
    }
    log(`checking: ${finding.title}`);
    const fileDiff = finding.file
      ? (packed.diff
          .split(/^(?=diff --git )/m)
          .find((d) => d.includes(` b/${finding.file}\n`)) ?? packed.diff)
      : packed.diff;
    checked++;
    // A failed call is an error, not a verdict: it must never turn into an approval.
    const reply = await complete(
      GATE,
      gatePrompt(finding, fileDiff, packed, card, options.decisions),
      "judge-fp-gate",
    );
    let gate: z.infer<typeof GateSchema>;
    try {
      gate = GateSchema.parse(extractJson(reply));
    } catch {
      gate = {
        reproducible: false,
        repro: "",
        reason: "the check didn't return a verdict",
      };
    }
    if (gate.reproducible && gate.repro.trim().length >= 20) {
      blocking.push({ ...finding, repro: gate.repro.trim() });
    } else {
      suggestions.push({
        ...finding,
        kind: "suggestion",
        downgraded: `no reproduction confirmed${gate.reason ? `: ${gate.reason}` : ""}`,
      });
    }
  }

  // A criterion with a confirmed blocking finding against it isn't met,
  // whatever the reviewer marked: T-0012's A5 was "met" beside the defect
  // that broke it.
  for (const f of blocking) {
    if (!f.acceptance_id || !cardIds.has(f.acceptance_id)) continue;
    const i = acceptance.findIndex((a) => a.id === f.acceptance_id);
    const unmetNote = `a blocking ${f.kind} finding: ${f.title}`;
    if (i === -1)
      acceptance = [
        ...acceptance,
        { id: f.acceptance_id, status: "unmet", note: unmetNote },
      ];
    else if (acceptance[i]?.status !== "unmet")
      acceptance = acceptance.map((a, j) =>
        j === i ? { ...a, status: "unmet" as const, note: unmetNote } : a,
      );
  }

  log(
    `review: ${calls} call(s) · ${usage.tokens} tokens · $${usage.costUsd.toFixed(2)}`,
  );
  return {
    verdict: blocking.length > 0 ? "request-changes" : "approve",
    blocking,
    suggestions,
    acceptance,
    ...(checkBefore
      ? {
          before: review.before ?? {
            shows_defect: false,
            note: "the reviewer didn't answer",
            criteria: [],
          },
        }
      : {}),
    unreviewed,
    ...(card ? { unverified: unverifiedCriteria(card, acceptance) } : {}),
    model,
    ...effort,
    calls,
    usage,
    packed: packedOut,
  };
}

/** Marker in every review body, so later rounds can be counted. */
export const REVIEW_MARKER = "<!-- rivetari-judge-review";

/** What the marker line carries besides the round, for a later review to read. */
export interface ReviewMarks {
  /** The reviewed head's tree, so a head with the same tree can carry this verdict. */
  tree?: string | undefined;
  /** Set on a review that carried an earlier verdict instead of reviewing. */
  carried?: { from: string; url?: string | undefined } | undefined;
}

/** The review as Markdown: blocking findings first, then one block of suggestions. */
export function renderReview(
  result: Tier2Result,
  round: number,
  verdict: "approve" | "request-changes" | "needs-human",
  marks: ReviewMarks = {},
): string {
  const where = (f: Finding) =>
    f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
  const lines = [
    `${REVIEW_MARKER} round=${round}${marks.tree ? ` verdict=${verdict} tree=${marks.tree}` : ""}${marks.carried ? ` carried=${marks.carried.from}` : ""} -->`,
    `### Rivetari judge · round ${round} · ${verdict === "approve" ? "approve" : verdict === "needs-human" ? "needs a human" : marks.carried ? "request changes" : `${result.blocking.length} blocking`}`,
  ];
  if (marks.carried) {
    lines.push(
      "",
      `Carried from \`${marks.carried.from.slice(0, 12)}\`${marks.carried.url ? ` (${marks.carried.url})` : ""}: this head's tree${marks.tree ? ` \`${marks.tree.slice(0, 12)}\`` : ""} is identical to the one reviewed there, so its verdict holds unchanged and no new review ran.`,
    );
  }
  if (verdict === "needs-human") {
    const unverified = result.unverified ?? [];
    lines.push(
      "",
      result.blocking.length > 0
        ? "Two review rounds have run and blocking findings remain, so this goes to a person instead of another automated round."
        : result.unreviewed.length > 0
          ? "Some changed files weren't shown to the reviewer (listed at the end), so a person has to look at them: the judge doesn't approve what it hasn't seen."
          : `Acceptance the reviewer couldn't verify, so a person decides it: ${unverified.map((u) => `${u.id} (${u.note})`).join("; ")}.`,
    );
  }
  if (result.blocking.length > 0) {
    lines.push("", "#### Blocking");
    for (const f of result.blocking) {
      lines.push(
        "",
        `**${f.kind}${f.acceptance_id ? ` (${f.acceptance_id})` : ""}: ${f.title}** ${where(f)}`,
        f.detail,
        ...(f.repro ? [`- **Repro:** ${f.repro}`] : []),
        ...(f.fix ? [`- **Fix:** ${f.fix}`] : []),
      );
    }
  }
  if (result.acceptance.length > 0) {
    lines.push(
      "",
      "#### Acceptance",
      ...result.acceptance.map(
        (a) => `- ${a.id}: ${a.status}${a.note ? ` — ${a.note}` : ""}`,
      ),
      ...(result.before
        ? [
            `- before proof: ${result.before.shows_defect ? "shows the defect" : "doesn't show the defect"}${result.before.note ? ` — ${result.before.note}` : ""}`,
          ]
        : []),
    );
  }
  if (result.suggestions.length > 0) {
    lines.push(
      "",
      `<details><summary>${result.suggestions.length} suggestion(s), non-blocking</summary>`,
      "",
    );
    for (const f of result.suggestions) {
      lines.push(
        `- ${f.title} ${where(f)}${f.downgraded ? ` _(downgraded: ${f.downgraded})_` : ""}${f.fix ? ` — ${f.fix}` : ""}`,
      );
    }
    lines.push("", "</details>");
  }
  if (result.packed.omitted.length > 0) {
    lines.push(
      "",
      `_Not reviewed: ${result.packed.omitted.map((o) => `\`${o.path}\` (${o.why}${o.stats ? `, ${o.stats}` : ""})`).join(", ")}._`,
    );
  }
  if (result.packed.trimmed?.length) {
    lines.push(
      "",
      `_Shown in part: ${result.packed.trimmed.map((t) => `\`${t.path}\``).join(", ")}._`,
    );
  }
  lines.push(
    "",
    `_${result.model}${result.effort ? ` (${result.effort} effort)` : ""} · ${result.calls} call(s) · ${result.usage.tokens} tokens · $${result.usage.costUsd.toFixed(2)} · Claude reviews, humans merge._`,
  );
  return lines.join("\n");
}
