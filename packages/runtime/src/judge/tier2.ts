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
import { isTestFile, parseNameStatus } from "./protected.js";

export const BLOCKING_KINDS = ["defect", "contract", "acceptance"] as const;
export const FINDING_KINDS = [...BLOCKING_KINDS, "suggestion"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

/** Default judge model, deliberately not the drafting default (independence). */
export const JUDGE_DEFAULT_MODEL = "claude-opus-5-5";
/** Max characters of diff packed into the prompt (~35k tokens). */
const DIFF_BUDGET = 400_000;

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
  omitted: { path: string; why: string }[];
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
  model: string;
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
  /** YYYY-MM-DD for the usage log; no log when omitted. */
  usageDate?: string | undefined;
  log?: ((line: string) => void) | undefined;
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
  const files: string[] = [];
  const lines = new Map<string, Set<number>>();
  let diff = "";
  for (const entry of entries) {
    if (isSensitivePath(entry.path)) {
      omitted.push({ path: entry.path, why: "sensitive path" });
      continue;
    }
    if (generated.has(entry.path)) {
      omitted.push({ path: entry.path, why: "generated" });
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
    if (diff.length + fileDiff.length > DIFF_BUDGET) {
      omitted.push({ path: entry.path, why: "over the review's size budget" });
      continue;
    }
    diff += fileDiff;
    files.push(entry.path);
    lines.set(entry.path, newSideLines(fileDiff));
  }
  const docs = files.filter((f) => MARKDOWN.test(f));
  return {
    diff,
    files,
    omitted,
    lines,
    agents: await showAt(git, base, "AGENTS.md"),
    constraints: await showAt(git, base, "CONSTRAINTS.md"),
    banned: bannedSection(await loadBanned(repoPath, base)).join("\n") || null,
    ...(docs.length > 0
      ? { cited: await citedFiles(git, head, docs, diff) }
      : {}),
  };
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

A contract finding must break a rule quoted from the contract given below; an acceptance finding must leave a criterion given below unmet. A rule or criterion that isn't in the text given doesn't exist.

Reply with ONLY a JSON object: {"reproducible": true|false, "repro": "exact steps, or empty", "reason": "one line"}`;

/** A fix card proved with screenshots: its "before" has to show the defect. */
export const needsBeforeCheck = (card?: Card, proof?: ReviewProof): boolean =>
  card?.type === "fix" && proof?.kind === "ui-screenshots";

function shotLine(shot: NonNullable<ReviewProof["shots"]>[number]): string {
  const where = `${shot.side} · ${shot.page} at ${shot.breakpoint} · HTTP ${shot.status} · ${shot.file.replace(/\\/g, "/").split("/").pop() ?? ""}`;
  const l = shot.layout;
  if (!l) return `- ${where} · nothing measured`;
  const overflow =
    l.scrollWidth > l.viewport
      ? `scrolls sideways: ${l.scrollWidth}px of content in a ${l.viewport}px viewport`
      : `no sideways scroll (${l.scrollWidth}px in a ${l.viewport}px viewport)`;
  const past =
    l.overflowing.length > 0
      ? `elements past the viewport's edge: ${l.overflowing.join("; ")}`
      : "no element past the viewport's edge";
  return `- ${where} · ${overflow} · ${past}${l.text ? ` · text starts: ${JSON.stringify(l.text)}` : ""}`;
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
      `### Screenshots\nYou can't see the images. For each one you have its side (before = the base, after = the change), page, breakpoint (sm 375px, md 768px, lg 1280px wide), HTTP status, and what the proof runner measured on the page.\n${proof.shots.map(shotLine).join("\n")}`,
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
): string {
  const parts: string[] = [];
  if (card) {
    parts.push(
      `## Task card ${card.id}: ${card.title}\n${card.description}\n\nAcceptance criteria:\n${card.acceptance.map((a) => `- ${a.id} (${a.verify}): ${a.text}`).join("\n")}` +
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
      `## Not shown to you\n${packed.omitted.map((o) => `- ${o.path}: ${o.why}`).join("\n")}`,
    );
  }
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
  if (finding.kind === "acceptance") {
    const criteria = card
      ? card.acceptance
          .map((a) => `- ${a.id} (${a.verify}): ${a.text}`)
          .join("\n")
      : "(no task card)";
    parts.push(`## Acceptance criteria\n${criteria}`);
  }
  parts.push(`## The diff\n${fileDiff}`);
  return parts.join("\n\n");
}

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

/**
 * Run the review: one call for findings, then one fresh-context call per
 * blocking finding (up to a cap) to confirm it reproduces. Findings that fail
 * the gate, or exceed the cap, become suggestions.
 */
export async function runTier2(options: Tier2Options): Promise<Tier2Result> {
  const log = options.log ?? (() => undefined);
  const model = options.model ?? JUDGE_DEFAULT_MODEL;
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

  log(`reviewing ${packed.files.length} file(s) with ${model}`);
  const review = ReviewSchema.parse(
    extractJson(
      await complete(
        RUBRIC,
        reviewPrompt(packed, options.card, options.decisions, options.proof),
        "judge-review",
      ),
    ),
  );
  const checkBefore = needsBeforeCheck(options.card, options.proof);
  const acceptance =
    checkBefore && options.card
      ? applyBeforeCheck(review.acceptance, options.card, review.before)
      : review.acceptance;

  // An unmet criterion blocks like any acceptance finding, even when the
  // reviewer only marked it unmet.
  const cited = new Set(
    review.findings
      .filter((f) => f.kind === "acceptance" && f.acceptance_id)
      .map((f) => f.acceptance_id),
  );
  const unmet: Finding[] = review.acceptance
    .filter(
      (a) =>
        a.status === "unmet" &&
        !cited.has(a.id) &&
        options.card?.acceptance.some((c) => c.id === a.id),
    )
    .map((a) => ({
      kind: "acceptance",
      file: "",
      line: null,
      acceptance_id: a.id,
      title: `${a.id} is unmet`,
      detail: a.note,
      repro: a.note,
      fix: "",
    }));

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
      gatePrompt(finding, fileDiff, packed, options.card, options.decisions),
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
    unreviewed: packed.omitted
      .filter((o) => o.why !== "generated")
      .map((o) => o.path),
    model,
    calls,
    usage,
    packed: {
      files: packed.files,
      omitted: packed.omitted,
      lines: packed.lines,
      agents: packed.agents,
      constraints: packed.constraints,
    },
  };
}

/** Marker in every review body, so later rounds can be counted. */
export const REVIEW_MARKER = "<!-- rivetari-judge-review";

/** The review as Markdown: blocking findings first, then one block of suggestions. */
export function renderReview(
  result: Tier2Result,
  round: number,
  verdict: "approve" | "request-changes" | "needs-human",
): string {
  const where = (f: Finding) =>
    f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`` : "";
  const lines = [
    `${REVIEW_MARKER} round=${round} -->`,
    `### Rivetari judge · round ${round} · ${verdict === "approve" ? "approve" : verdict === "needs-human" ? "needs a human" : `${result.blocking.length} blocking`}`,
  ];
  if (verdict === "needs-human") {
    lines.push(
      "",
      result.blocking.length > 0
        ? "Two review rounds have run and blocking findings remain, so this goes to a person instead of another automated round."
        : "Some changed files weren't shown to the reviewer (listed at the end), so a person has to look at them: the judge doesn't approve what it hasn't seen.",
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
      `_Not reviewed: ${result.packed.omitted.map((o) => `\`${o.path}\` (${o.why})`).join(", ")}._`,
    );
  }
  lines.push(
    "",
    `_${result.model} · ${result.calls} call(s) · Claude reviews, humans merge._`,
  );
  return lines.join("\n");
}
