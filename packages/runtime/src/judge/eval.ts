// The judge eval: real changes from a pilot, each with its card and a label
// saying whether it holds a defect and who caught it, judged again by today's
// judge. A case is a directory:
//
//   case.json     the label, the defect, where it was caught, the signals a
//                 catch must name, the profile bits, the stops answered before
//                 the round, and tier 1's recorded outcomes from the pilot
//   card.yml      the task card;  assembly.yml  the approved assembly
//   proof.json    the proof the pilot's judge was shown (optional)
//   change.diff   `git diff --binary` from base to head
//   base.json     the base's files the change, its tests and the review
//                 need, as {"files": {path: {"utf8"|"base64": content}}}: one
//                 file, so the repo's own lint and format never read them
//
// Each case becomes a two-commit repo (base, then base plus the diff), and the
// round runs as the task judge runs it: tier 1 on a clean clone, the derived
// risk, the review with the same model plan, and the same decision. Checks
// the eval can't run offline (lint and typecheck need the repo installed) are
// replayed from the pilot's run on the same commits and say so; a check with
// no recording is not run and never counts as a pass. Only the model calls
// need the network.
import {
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import type { AiClient } from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { parse } from "yaml";

import { type Assembly, AssemblySchema } from "../router/route.js";
import { type Card, parseCard } from "../task/card.js";
import type { LedgerEntry } from "../task/ledger.js";
import { allowedDecisions } from "../task/tasks.js";
import {
  decideAfterReview,
  decideBeforeReview,
  type RoundDecision,
  reviewRound,
} from "./decide.js";
import {
  judgeGit,
  scratchEnvFor,
  scratchGitEnv,
  useScratchGit,
} from "./git.js";
import type { CheckOutcome } from "./outcome.js";
import { protectedDetail } from "./protected.js";
import type { reviewLocal } from "./review.js";
import { judgeRisk } from "./risk-check.js";
import { runTier1 } from "./tier1.js";
import type { ReviewProof } from "./tier2.js";

/** A case's label and what the eval needs to replay it, as `case.json` holds them. */
export interface EvalCaseMeta {
  id: string;
  task: string;
  round: number;
  label: "defect" | "clean";
  expected: "block" | "pass";
  /** The defect, or for a clean case what (if anything) went wrong around it. */
  defect: string | null;
  /** Who caught the defect in the pilot: judge, decider, pilot, owner, or nobody. */
  caught_by: string | null;
  caught_detail: string;
  /** Patterns (case-insensitive) a block must name to count as catching the defect. */
  signals: string[];
  source: { repo: string; pr: number | null; base: string; head: string };
  pilot: {
    verdict: string;
    blocking: number;
    acceptance: Record<string, string>;
    model: string | null;
    cost_usd: number;
  };
  profile: { no_new_comments: boolean; generated: string[]; autonomy: string };
  /** The stop section of the ledger before the round's verdict. */
  stops: { text: string; by: string; at: string }[];
  /** Tier 1's catalog checks as the pilot's judge ran them on these commits. */
  recorded_tier1: CheckOutcome[];
  /** Whether the change's tests run offline (no package beyond the test runner). */
  offline_tests: boolean;
  test_packages: string[];
  proof_note?: string | null;
}

export interface EvalCase {
  dir: string;
  meta: EvalCaseMeta;
  card: Card;
  assembly: Assembly;
  proof: ReviewProof | null;
}

/** How a case came out against its label. */
export type CaseOutcome =
  /** A defect, blocked for a reason that names it. */
  | "caught"
  /** A defect, blocked, but for a reason that doesn't name it. */
  | "blocked-other"
  /** A defect the judge passed. */
  | "missed"
  /** A clean change the judge passed. */
  | "pass"
  /** A clean change sent back to build. */
  | "false-block"
  /** A clean change stopped for a person (unverified or unseen). */
  | "held"
  /** Tier 1 left it to a review that wasn't run (`tier2: false`). */
  | "not-reviewed"
  /** The case couldn't be judged; never a pass and never a catch. */
  | "error";

export interface CaseCheck {
  id: string;
  outcome: CheckOutcome["outcome"];
  /** live: ran in this eval; recorded: replayed from the pilot; not run. */
  source: "live" | "recorded" | "not run";
  message: string;
}

export interface CaseRun {
  id: string;
  task: string;
  label: EvalCaseMeta["label"];
  expected: EvalCaseMeta["expected"];
  caughtBy: string | null;
  pilotVerdict: string;
  outcome: CaseOutcome;
  verdict: RoundDecision["verdict"] | null;
  why: string;
  /** The signals a block's reasons matched. */
  matched: string[];
  /** Every reason the round gave for not passing, which the signals were matched against. */
  reasons: string[];
  tier1: {
    verdict: string;
    changedFiles: number;
    protected: string[];
    notes: string[];
    checks: CaseCheck[];
  } | null;
  risk: { card: string; effective: string; reasons: string[] } | null;
  review: {
    model: string;
    effort: string | null;
    plan: string;
    verdict: string;
    blocking: {
      kind: string;
      title: string;
      file: string;
      acceptance_id: string | null;
    }[];
    acceptance: { id: string; status: string; note: string }[];
    suggestions: { title: string; downgraded: string | null }[];
    unreviewed: string[];
    tokens: number;
    costUsd: number;
  } | null;
  asks: string[];
  notes: string[];
  durationMs: number;
  error?: string | undefined;
}

export interface EvalSummary {
  defects: number;
  caught: number;
  blockedOther: number;
  missed: number;
  clean: number;
  passed: number;
  falseBlocks: number;
  held: number;
  notReviewed: number;
  errors: number;
  tokens: number;
  costUsd: number;
  durationMs: number;
}

export interface EvalResult {
  at: string;
  label: string;
  /** The Rivetari commit the judge ran from, when known. */
  commit: string | null;
  tier2: boolean;
  model: string | null;
  summary: EvalSummary;
  cases: CaseRun[];
}

export interface JudgeEvalOptions {
  casesDir: string;
  /** Run only these case ids. */
  only?: readonly string[] | undefined;
  /** Where each case's repo and clone go (default: `<casesDir>/../.work`). */
  workRoot?: string | undefined;
  /** Where the JSON result goes (default: none written). */
  outDir?: string | undefined;
  label?: string | undefined;
  commit?: string | null | undefined;
  /** Run the review (default true); false judges tier 1 alone, for free. */
  tier2?: boolean | undefined;
  /** One model for every review, past the risk-based choice. */
  model?: string | undefined;
  ai?: AiClient | undefined;
  fastAi?: AiClient | undefined;
  review?: typeof reviewLocal | undefined;
  /** Cases judged at once (default 2). */
  concurrency?: number | undefined;
  now?: Date | undefined;
  log?: ((line: string) => void) | undefined;
}

const CHECK_RUNS_TESTS = "quality.tests.pass";
const CASE_ID = /^[A-Za-z0-9][\w.-]*$/;

/** A case file's text, or null when it doesn't exist; any other error is thrown. */
async function readIfThere(path: string): Promise<string | null> {
  return readFile(path, "utf8").catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw new Error(`can't read ${path}: ${err.message}`);
  });
}

/** Every case under `root` (each directory with a `case.json`), by id. */
export async function loadEvalCases(
  root: string,
  only?: readonly string[],
): Promise<EvalCase[]> {
  const names = (await readdir(root, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  const cases: EvalCase[] = [];
  for (const name of names) {
    const dir = join(root, name);
    const metaText = await readIfThere(join(dir, "case.json"));
    if (metaText === null) continue;
    const meta = JSON.parse(metaText) as EvalCaseMeta;
    // The id names the case's work directory, which is deleted after it's
    // judged, so it can only be a plain name: never "..", a path or empty.
    if (typeof meta.id !== "string" || !CASE_ID.test(meta.id))
      throw new Error(
        `${join(dir, "case.json")}: id must be letters, digits, ".", "_" or "-", starting with a letter or digit`,
      );
    if (only && only.length > 0 && !only.includes(meta.id)) continue;
    const card = parseCard(
      parse(await readFile(join(dir, "card.yml"), "utf8")),
    );
    const assembly = AssemblySchema.parse(
      parse(await readFile(join(dir, "assembly.yml"), "utf8")),
    );
    const proofText = await readIfThere(join(dir, "proof.json"));
    cases.push({
      dir,
      meta,
      card,
      assembly,
      proof: proofText === null ? null : (JSON.parse(proofText) as ReviewProof),
    });
  }
  const missing = (only ?? []).filter(
    (id) => !cases.some((c) => c.meta.id === id),
  );
  if (missing.length > 0)
    throw new Error(`no such case in ${root}: ${missing.join(", ")}`);
  return cases;
}

export { scratchGitEnv };

const samePath = (p: string) =>
  process.platform === "win32" ? p.toLowerCase() : p;
const inside = (p: string, dir: string) =>
  samePath(p).startsWith(samePath(dir) + sep);

/**
 * `target` resolved for a write or delete inside `root`, or an error. The
 * nearest part of it that exists is resolved with realpath, so a symlink or
 * junction can't carry the write or delete out of `root`; the segments below
 * it don't exist yet, so none of them is a link. Every write and delete of a
 * case's files goes through here.
 */
export async function contained(root: string, target: string): Promise<string> {
  const realRoot = await realpath(root);
  let existing = resolve(root, target);
  const below: string[] = [];
  while (!(await stat(existing).catch(() => null))) {
    below.unshift(basename(existing));
    existing = dirname(existing);
  }
  const real = join(await realpath(existing), ...below);
  if (!inside(real, realRoot))
    throw new Error(`${target} resolves outside ${root}`);
  return real;
}

/** Deletes `target`, recursively, only once it resolves inside `root`. */
async function removeIn(root: string, target: string): Promise<void> {
  await rm(await contained(root, target), { recursive: true, force: true });
}

/**
 * Where a case's base file lands, or an error: inside the repo, by realpath,
 * and outside its git dir.
 */
export async function scratchPath(
  repoPath: string,
  path: string,
): Promise<string> {
  const root = await realpath(repoPath);
  const gitDir = await realpath(join(repoPath, ".git"));
  const real = await contained(repoPath, path).catch(() => {
    throw new Error(`base.json names a path outside the repo: ${path}`);
  });
  // Windows drops trailing dots and spaces and answers to the 8.3 name, so
  // those spellings of .git are refused before they reach the disk.
  const top = relative(root, real)
    .split(sep)[0]
    ?.replace(/[. ]+$/, "")
    .toLowerCase();
  if (
    samePath(real) === samePath(gitDir) ||
    inside(real, gitDir) ||
    top === ".git" ||
    /^git~\d+$/.test(top ?? "")
  )
    throw new Error(`base.json names a path inside .git: ${path}`);
  return real;
}

/**
 * Makes `work` a scratch folder: an empty hooks directory and an empty global
 * config inside it, beside the repo where no base file can reach them, and
 * every judge git call inside it runs with the scratch environment until the
 * returned release runs. A folder that already is one is left as it is.
 */
export async function openScratch(work: string): Promise<() => void> {
  await mkdir(work, { recursive: true });
  if (scratchEnvFor([work])) return () => undefined;
  const gitEnv = await contained(work, "git-env");
  await removeIn(work, gitEnv);
  const noHooks = await contained(work, join("git-env", "no-hooks"));
  await mkdir(noHooks, { recursive: true });
  const emptyConfig = await contained(work, join("git-env", "gitconfig"));
  await writeFile(emptyConfig, "");
  return useScratchGit(work, scratchGitEnv(noHooks, emptyConfig));
}

/**
 * The case as a repo: a commit of its base files, then one of the base plus
 * its diff. Returns both commits. The repo's folder is a scratch folder for
 * as long as this runs; judgeCase keeps it one for the whole case.
 */
export async function materializeCase(
  c: Pick<EvalCase, "dir">,
  repoPath: string,
): Promise<{ base: string; head: string }> {
  const work = dirname(resolve(repoPath));
  const release = await openScratch(work);
  try {
    const repo = await contained(work, repoPath);
    await removeIn(work, repo);
    await mkdir(repo, { recursive: true });
    const git = judgeGit(repo);
    await git.init(["--quiet"]);
    // No line-ending rewrites or signing may change what the repo holds.
    await git.addConfig("core.autocrlf", "false");
    await git.addConfig("commit.gpgsign", "false");
    await git.addConfig("user.name", "rivetari judge eval");
    await git.addConfig("user.email", "judge-eval@rivetari.invalid");
    for (const [path, file] of Object.entries(await baseFiles(c.dir))) {
      const at = await scratchPath(repo, path);
      await mkdir(dirname(at), { recursive: true });
      await writeFile(
        at,
        "base64" in file
          ? Buffer.from(file.base64, "base64")
          : Buffer.from(file.utf8, "utf8"),
      );
    }
    await git.raw(["add", "-A"]);
    await git.raw(["commit", "--quiet", "--allow-empty", "-m", "base"]);
    const base = (await git.revparse(["HEAD"])).trim();
    const diff = join(c.dir, "change.diff");
    if ((await stat(diff).catch(() => null))?.size)
      await git.raw([
        "apply",
        "--binary",
        "--whitespace=nowarn",
        resolve(diff),
      ]);
    await git.raw(["add", "-A"]);
    await git.raw(["commit", "--quiet", "--allow-empty", "-m", "head"]);
    return { base, head: (await git.revparse(["HEAD"])).trim() };
  } finally {
    release();
  }
}

type BaseFile = { utf8: string } | { base64: string };

/** A case's base files; none when it has no `base.json`. */
async function baseFiles(dir: string): Promise<Record<string, BaseFile>> {
  const text = await readIfThere(join(dir, "base.json"));
  if (text === null) return {};
  return (JSON.parse(text) as { files: Record<string, BaseFile> }).files;
}

/** Whether the test runner the cases use resolves from `dir` (the work root). */
function testRunnerFrom(dir: string): boolean {
  try {
    createRequire(join(dir, "noop.js")).resolve("vitest/package.json");
    return true;
  } catch {
    return false;
  }
}

/** A case's outcome from its label and the round's decision. */
export function scoreCase(
  meta: Pick<EvalCaseMeta, "expected" | "signals">,
  decision: Pick<RoundDecision, "verdict">,
  reasons: readonly string[],
): { outcome: CaseOutcome; matched: string[] } {
  const text = reasons.join("\n");
  const matched = meta.signals.filter((s) => new RegExp(s, "i").test(text));
  if (meta.expected === "pass")
    return {
      outcome:
        decision.verdict === "passed"
          ? "pass"
          : decision.verdict === "failed"
            ? "false-block"
            : "held",
      matched,
    };
  if (decision.verdict === "passed") return { outcome: "missed", matched };
  return {
    outcome:
      meta.signals.length === 0 || matched.length > 0
        ? "caught"
        : "blocked-other",
    matched,
  };
}

/** Judge one case as the task judge would judge its round. */
export async function judgeCase(
  c: EvalCase,
  options: Omit<JudgeEvalOptions, "casesDir" | "only" | "outDir" | "label"> & {
    workRoot: string;
  },
): Promise<CaseRun> {
  const started = Date.now();
  const { meta, card, assembly } = c;
  const log = (line: string) => options.log?.(`${meta.id}: ${line}`);
  const run: CaseRun = {
    id: meta.id,
    task: meta.task,
    label: meta.label,
    expected: meta.expected,
    caughtBy: meta.caught_by,
    pilotVerdict: meta.pilot.verdict,
    outcome: "error",
    verdict: null,
    why: "",
    matched: [],
    reasons: [],
    tier1: null,
    risk: null,
    review: null,
    asks: [],
    notes: [],
    durationMs: 0,
  };
  const work = resolve(options.workRoot, meta.id);
  let release: () => void = () => undefined;
  if (!CASE_ID.test(meta.id) || dirname(work) !== resolve(options.workRoot))
    throw new Error(`case id ${JSON.stringify(meta.id)} isn't a plain name`);
  try {
    await mkdir(options.workRoot, { recursive: true });
    await contained(options.workRoot, work);
    release = await openScratch(work);
    const repoPath = join(work, "repo");
    const { base, head } = await materializeCase(c, repoPath);
    const entries = meta.stops.map((s, i): LedgerEntry => ({
      seq: i + 1,
      at: s.at,
      beat: "build",
      section: "stop",
      text: s.text,
      by: s.by,
      prev: "",
      mac: "",
    }));
    const decisions = allowedDecisions({ entries });
    const allowed = new Set(decisions.map((d) => d.asked));

    // Tests run here when the case's tests need nothing past the runner and
    // the runner resolves from the work root; every other check the assembly
    // names is the pilot's recording, or not run.
    const runner = testRunnerFrom(options.workRoot);
    const liveTests =
      meta.offline_tests &&
      runner &&
      assembly.checks.includes(CHECK_RUNS_TESTS);
    if (meta.offline_tests && !runner)
      run.notes.push(
        `tests not run live: vitest doesn't resolve from ${options.workRoot}; the pilot's recorded run stands in`,
      );
    const live = liveTests ? [CHECK_RUNS_TESTS] : [];
    const recorded = assembly.checks
      .filter((id) => !live.includes(id))
      .flatMap((id): CheckOutcome[] => {
        const r = meta.recorded_tier1.find((x) => x.id === id);
        return r
          ? [
              {
                ...r,
                message: `recorded in the pilot's judge run: ${r.message}`,
              },
            ]
          : [];
      });
    const tier1 = await runTier1({
      repoPath,
      base,
      head,
      checks: live,
      recordedChecks: recorded,
      allowed: (f) => allowed.has(`protected_path: ${protectedDetail(f)}`),
      card,
      noNewComments: meta.profile.no_new_comments,
      generatedGlobs: meta.profile.generated,
      install: false,
      workDir: join(work, "clone"),
      log,
    });
    const sourceOf = (id: string): CaseCheck["source"] =>
      live.includes(id) || !id.startsWith("quality.")
        ? "live"
        : recorded.some((r) => r.id === id)
          ? "recorded"
          : "not run";
    run.tier1 = {
      verdict: tier1.verdict,
      changedFiles: tier1.changedFiles,
      protected: tier1.protected.map((p) => protectedDetail(p)),
      notes: tier1.notes,
      checks: [
        ...tier1.checks.map((ch) => ({
          id: ch.id,
          outcome: ch.outcome,
          source: sourceOf(ch.id),
          message: ch.message,
        })),
        ...assembly.checks
          .filter((id) => !tier1.checks.some((ch) => ch.id === id))
          .map((id): CaseCheck => ({
            id,
            outcome: "n/a",
            source: "not run",
            message: "not run in the eval and no recording from the pilot",
          })),
      ],
    };
    const sensitive = assembly.stop_and_ask.flatMap((s) =>
      typeof s === "string" ? [] : s.touches,
    );
    const risk = await judgeRisk({
      repoPath,
      base: tier1.mergeBase,
      head,
      card,
      sensitive,
    });
    run.risk = risk;

    let decision = decideBeforeReview({
      tier1,
      pendingProtected: tier1.protected.filter(
        (p) => !allowed.has(`protected_path: ${protectedDetail(p)}`),
      ).length,
      card,
      round: meta.round,
    });
    const reasons: string[] = [
      ...tier1.checks
        .filter((ch) => ch.outcome === "fail")
        .map((ch) => `${ch.id}: ${ch.message}`),
      ...(tier1.verdict === "fail" ? tier1.notes : []),
    ];
    if (!decision) {
      if (options.tier2 === false) {
        run.outcome = "not-reviewed";
        run.why = "tier 1 passed; the review wasn't run";
        return run;
      }
      const proof: ReviewProof = c.proof ?? {
        kind: assembly.proof,
        passed: false,
        lines: ["no proof record was found for this round"],
      };
      const { outcome, plan } = await reviewRound({
        repoPath,
        card,
        risk: risk.effective,
        base: tier1.mergeBase,
        head,
        round: meta.round,
        sensitive,
        proof,
        decisions,
        tier1: tier1.checks,
        model: options.model,
        ai: options.ai,
        fastAi: options.fastAi,
        review: options.review,
        log,
        onEscalate: async (message) => {
          run.notes.push(message);
        },
      });
      const r = outcome.result;
      run.review = {
        model: r.model,
        effort: r.effort ?? null,
        plan: plan.why,
        verdict: outcome.verdict,
        blocking: r.blocking.map((f) => ({
          kind: f.kind,
          title: f.title,
          file: f.file,
          acceptance_id: f.acceptance_id ?? null,
        })),
        acceptance: r.acceptance.map((a) => ({
          id: a.id,
          status: a.status,
          note: a.note,
        })),
        suggestions: r.suggestions.map((f) => ({
          title: f.title,
          downgraded: f.downgraded ?? null,
        })),
        unreviewed: r.unreviewed,
        tokens: r.usage.tokens,
        costUsd: r.usage.costUsd,
      };
      decision = await decideAfterReview({
        card,
        round: meta.round,
        outcome,
        allowed,
        autonomy: async () => meta.profile.autonomy,
      });
      reasons.push(
        ...r.blocking.map((f) => `${f.title}\n${f.detail}\n${f.repro}`),
        ...r.acceptance
          .filter((a) => a.status !== "met")
          .map((a) => `${a.id} ${a.status}: ${a.note}`),
      );
    }
    reasons.push(decision.why, ...decision.asks);
    const scored = scoreCase(meta, decision, reasons);
    run.verdict = decision.verdict;
    run.why = decision.why;
    run.asks = decision.asks;
    run.outcome = scored.outcome;
    run.matched = scored.matched;
    run.reasons = reasons.filter(Boolean);
    return run;
  } catch (err) {
    run.outcome = "error";
    run.error = (err as Error).message;
    return run;
  } finally {
    run.durationMs = Date.now() - started;
    release();
    await removeIn(options.workRoot, work).catch((err: unknown) =>
      log(
        `couldn't remove ${work}: ${err instanceof Error ? err.message : String(err)}`,
      ),
    );
  }
}

export function summarize(cases: readonly CaseRun[]): EvalSummary {
  const n = (o: CaseOutcome) => cases.filter((c) => c.outcome === o).length;
  return {
    defects: cases.filter((c) => c.label === "defect").length,
    caught: n("caught"),
    blockedOther: n("blocked-other"),
    missed: n("missed"),
    clean: cases.filter((c) => c.label === "clean").length,
    passed: n("pass"),
    falseBlocks: n("false-block"),
    held: n("held"),
    notReviewed: n("not-reviewed"),
    errors: n("error"),
    tokens: cases.reduce((t, c) => t + (c.review?.tokens ?? 0), 0),
    costUsd: cases.reduce((t, c) => t + (c.review?.costUsd ?? 0), 0),
    durationMs: cases.reduce((t, c) => t + c.durationMs, 0),
  };
}

/**
 * Judge every case and score it. With `outDir`, the result is written there
 * as `<date>-<label>.json`.
 */
export async function runJudgeEval(
  options: JudgeEvalOptions,
): Promise<{ result: EvalResult; file: string | null }> {
  const casesDir = resolve(options.casesDir);
  const cases = await loadEvalCases(casesDir, options.only);
  if (cases.length === 0) throw new Error(`no cases in ${casesDir}`);
  const workRoot = resolve(options.workRoot ?? join(casesDir, "..", ".work"));
  await mkdir(workRoot, { recursive: true });
  const runs: CaseRun[] = new Array<CaseRun>(cases.length);
  let next = 0;
  const worker = async () => {
    while (next < cases.length) {
      const i = next++;
      const c = cases[i];
      if (!c) continue;
      options.log?.(`${c.meta.id}: judging (${i + 1}/${cases.length})`);
      runs[i] = await judgeCase(c, { ...options, workRoot });
      options.log?.(`${c.meta.id}: ${runs[i]?.outcome}`);
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(options.concurrency ?? 2, cases.length)) },
      worker,
    ),
  );
  const at = (options.now ?? new Date()).toISOString();
  const label = options.label ?? "run";
  const result: EvalResult = {
    at,
    label,
    commit:
      options.commit === undefined
        ? await simpleGit(process.cwd())
            .revparse(["HEAD"])
            .then((s) => s.trim())
            .catch(() => null)
        : options.commit,
    tier2: options.tier2 !== false,
    model: options.model ?? null,
    summary: summarize(runs),
    cases: runs,
  };
  let file: string | null = null;
  if (options.outDir) {
    await mkdir(options.outDir, { recursive: true });
    const safe = label.replace(/[^\w.-]+/g, "-");
    file = join(options.outDir, `${at.slice(0, 10)}-${safe}.json`);
    await writeFile(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  }
  return { result, file };
}
