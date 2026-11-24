// The judge beat for a task: tier 1 on a clean clone of base plus
// the task's branch, then tier 2 on the same change against the card. Never
// the worktree. A protected change, or blocking findings past the round limit,
// stop and ask a person; anything else blocking goes back to the agent, and so
// does an unmet criterion or an empty change. A criterion the reviewer
// couldn't verify stops for a person at every autonomy level. The
// round's record is written to `.rivetari/tasks/<id>/judge/round-<n>.json` and
// its hash sealed in the verdict entry, so ship can trust what it reads.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type AiClient,
  buildContext,
  CallTimeoutError,
  callTimeoutMinutes,
  createAiClient,
} from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { parse } from "yaml";

import { loadIsolation } from "../agent/isolate.js";
import {
  DEFERRED,
  proofFromJudge,
  type ProofRecord,
  type Publish,
} from "../proof/prove.js";
import { AssemblySchema } from "../router/route.js";
import { autonomyFor } from "../task/autonomy.js";
import type { Card } from "../task/card.js";
import type { LedgerEntry } from "../task/ledger.js";
import {
  allowedDecisions,
  allowedStops,
  JUDGE_VERDICT,
  judgeVerdicts,
  listTasks,
  loadTask,
  nextStep,
  sha256,
  type Task,
  TaskError,
  TASKS_DIR,
} from "../task/tasks.js";
import {
  FAST_REVIEW_MODEL,
  FAST_REVIEW_TIMEOUT_MS,
  isFastPath,
} from "./fast-path.js";
import { type ProtectedFinding, protectedDetail } from "./protected.js";
import {
  type CarriedVerdict,
  MAX_ROUNDS,
  type ReviewOutcome,
  reviewLocal,
  treeOf,
} from "./review.js";
import { changeSize, reviewPlan } from "./review-plan.js";
import { type JudgedRisk, judgeRisk } from "./risk-check.js";
import { runTier1, type Tier1Options, type Tier1Result } from "./tier1.js";
import { JUDGE_DEFAULT_MODEL, unverifiedCriteria } from "./tier2.js";

export { unverifiedCriteria } from "./tier2.js";

/** What a judge round decided, as written to its record. */
export interface JudgeRecord {
  task: string;
  round: number;
  verdict: "passed" | "failed" | "needs a human";
  head: string;
  /**
   * The head's tree: a later head with the same one (a merge commit that adds
   * nothing) holds exactly what was judged. Absent in older records.
   */
  tree?: string | undefined;
  base: string;
  tier1: Pick<Tier1Result, "verdict" | "checks" | "protected" | "notes">;
  /** Absent when tier 1 didn't leave the decision to the review. */
  review?:
    | {
        verdict: ReviewOutcome["verdict"];
        body: string;
        model: string;
        /** The effort it ran at and why that model; absent in older records. */
        effort?: string | undefined;
        plan?: string | undefined;
        blocking: ReviewOutcome["result"]["blocking"];
        suggestions: ReviewOutcome["result"]["suggestions"];
        acceptance: ReviewOutcome["result"]["acceptance"];
        unreviewed: string[];
        usage: ReviewOutcome["result"]["usage"];
      }
    | undefined;
  /** The risk derived again from the change; absent in older records. */
  risk?: JudgedRisk | undefined;
}

export interface JudgeTaskOptions {
  by: string;
  now?: Date | undefined;
  /** The review's client (default: the subscription CLI, else the API key). */
  ai?: AiClient | undefined;
  /** One model for every review this round, past the risk-based choice. */
  model?: string | undefined;
  /** Tier 1 and tier 2, replaceable in tests. */
  tier1?: ((options: Tier1Options) => Promise<Tier1Result>) | undefined;
  review?: typeof reviewLocal | undefined;
  log?: ((line: string) => void) | undefined;
  /** Where a deferred test-run proof's evidence goes (default: GitHub). */
  publish?: Publish | undefined;
  /** The fast-path review's client (default: the short-timeout one). */
  fastAi?: AiClient | undefined;
}

const recordPath = (repoPath: string, id: string, round: number) =>
  join(repoPath, TASKS_DIR, id, "judge", `round-${round}.json`);
const SEALED = /· record sha256 ([0-9a-f]{64})$/;
const BUILT = /^build (?:done|paused)[^·]*· commit ([0-9a-f]{12})/;

const oneLine = (s: string, n = 300) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

const isVerdict = (e: LedgerEntry) =>
  e.beat === "judge" && e.section === "timeline" && JUDGE_VERDICT.test(e.text);

/** The round a verdict entry seals, read and checked against its hash. */
async function sealedRecord(
  repoPath: string,
  id: string,
  entry: LedgerEntry,
): Promise<JudgeRecord> {
  const round = Number(JUDGE_VERDICT.exec(entry.text)?.[2]);
  const text = await readFile(recordPath(repoPath, id, round), "utf8").catch(
    () => null,
  );
  if (text === null || sha256(text) !== SEALED.exec(entry.text)?.[1])
    throw new TaskError(
      `${TASKS_DIR}/${id}/judge/round-${round}.json doesn't match the record sealed in the ledger`,
    );
  return JSON.parse(text) as JudgeRecord;
}

/**
 * The latest judge round's record, checked against the hash in its verdict
 * entry. Null before the first verdict.
 */
export async function loadJudgeRecord(
  repoPath: string,
  task: Task,
): Promise<JudgeRecord | null> {
  const entry = task.entries.findLast(isVerdict);
  return entry ? sealedRecord(repoPath, task.card.id, entry) : null;
}

/** One judge round as its verdict entry and its record tell it. */
export interface JudgeRound {
  round: number;
  verdict: string;
  /** When the verdict was written. */
  at: string;
  /** Null when the record isn't there or doesn't match its seal; `problem` says which. */
  record: JudgeRecord | null;
  problem: string | null;
}

/**
 * Every judge round so far, oldest first, each record checked against the
 * hash in its own verdict entry. A round whose record can't be trusted is
 * kept, with why, so one bad file doesn't hide the others. Only the ledger
 * and the round files are read, so a task's view from the watcher will do.
 */
export async function loadJudgeRounds(
  repoPath: string,
  task: { card: Pick<Card, "id">; entries: LedgerEntry[] },
): Promise<JudgeRound[]> {
  const rounds: JudgeRound[] = [];
  for (const e of task.entries.filter(isVerdict)) {
    const [, verdict = "", round = "0"] = JUDGE_VERDICT.exec(e.text) ?? [];
    const base = { round: Number(round), verdict, at: e.at };
    try {
      rounds.push({
        ...base,
        record: await sealedRecord(repoPath, task.card.id, e),
        problem: null,
      });
    } catch (err) {
      rounds.push({ ...base, record: null, problem: (err as Error).message });
    }
  }
  return rounds;
}

/**
 * A task judge's passed round on a head with this tree, other than `head`
 * itself: what a merge commit with nothing new carries. Records from before
 * the tree was kept are matched by their head's tree, when git still has it.
 */
export async function findJudgedTree(
  repoPath: string,
  tree: string,
  head: string,
): Promise<CarriedVerdict | null> {
  let found: CarriedVerdict | null = null;
  let at = "";
  for (const task of await listTasks(repoPath, () => undefined)) {
    for (const r of await loadJudgeRounds(repoPath, task)) {
      const record = r.record;
      if (!record || record.verdict !== "passed" || record.head === head)
        continue;
      const judged =
        record.tree ?? (await treeOf(repoPath, record.head).catch(() => null));
      if (judged !== tree || r.at < at) continue;
      at = r.at;
      found = {
        verdict: "approve",
        from: record.head,
        source: `${record.task}'s judge, round ${record.round}`,
        round: record.round,
        body:
          record.review?.body ??
          `The judge passed ${record.task} in round ${record.round}; tier 1 decided it without a review.`,
      };
    }
  }
  return found;
}

/**
 * `rivetari task judge <id>`: judge the built, proved branch. Passed → ship.
 * Failed (rounds 1–2) → back to build with the findings. Needs a human (a
 * protected change, blocking findings in round 3, files the reviewer couldn't
 * see) → a stop-and-ask question; `--allow` ships it, `--deny` rebuilds.
 */
export async function judgeTask(
  repoPath: string,
  id: string,
  options: JudgeTaskOptions,
): Promise<{ task: Task; record: JudgeRecord }> {
  const log = options.log ?? (() => undefined);
  let task = await loadTask(repoPath, id);
  if (task.problems.length > 0)
    throw new TaskError(`task ${id} fails verification; not judging`);
  if (nextStep(task) !== "judge")
    throw new TaskError(`task ${id} isn't ready to judge: ${nextStep(task)}`);
  const isolation = await loadIsolation(repoPath, id);
  if (!isolation) throw new TaskError(`task ${id} has no worktree`);
  const assembly = AssemblySchema.parse(parse(task.assemblyText ?? ""));

  // Judge the commit the last build round made and the proof ran on, nothing
  // added to the branch since.
  const head = (
    await simpleGit(repoPath).revparse([`refs/heads/${isolation.branch}`])
  ).trim();
  const built = [...task.entries]
    .reverse()
    .map((e) =>
      e.beat === "build" && e.section === "timeline"
        ? BUILT.exec(e.text)?.[1]
        : undefined,
    )
    .find((c) => c !== undefined);
  if (!built || !head.startsWith(built))
    throw new TaskError(
      `${isolation.branch} is at ${head.slice(0, 12)}, but the last build round committed ${built ?? "nothing"}; build and prove again`,
    );

  const round = judgeVerdicts(task).length + 1;
  const by = `rivetari judge (for ${options.by})`;
  const append = (section: "timeline" | "judge" | "stop", text: string) =>
    task.ledger.append({ beat: "judge", section, text, by, at: options.now });

  log(`tier 1: ${assembly.checks.join(", ")}`);
  const allowed = allowedStops(task);
  const wasAllowed = (f: ProtectedFinding) =>
    allowed.has(`protected_path: ${protectedDetail(f)}`);
  const repoProfile = await buildContext(repoPath)
    .profile()
    .catch(() => null);
  const tier1 = await (options.tier1 ?? runTier1)({
    repoPath,
    base: isolation.base,
    head,
    checks: assembly.checks,
    allowed: wasAllowed,
    card: task.card,
    noNewComments: repoProfile?.quality?.["no-new-comments"] ?? false,
    generatedGlobs: repoProfile?.generated,
    persistent: true,
    log,
  });
  const proved = [...task.entries]
    .reverse()
    .find((e) => e.beat === "prove" && e.section === "timeline");
  if (proved?.text === DEFERRED)
    await proofFromJudge(
      repoPath,
      task,
      isolation,
      {
        testRun: tier1.testRun,
        outcome: tier1.checks.find((c) => c.id === "quality.tests.pass")
          ?.outcome,
      },
      { by: options.by, now: options.now, publish: options.publish },
    );
  const ran = tier1.checks.filter((c) => c.outcome !== "n/a");
  const count = (o: string) => ran.filter((c) => c.outcome === o).length;
  await append(
    "judge",
    `tier 1 round ${round}: ${tier1.verdict} · ${count("pass") + count("fixed")}/${ran.length} pass${count("pre-existing") ? ` · ${count("pre-existing")} pre-existing` : ""}${count("fail") ? ` · ${count("fail")} fail` : ""}`,
  );
  for (const c of tier1.checks.filter((c) => c.outcome === "fail"))
    await append("judge", `tier 1 fail: ${c.id} — ${oneLine(c.message)}`);
  // A note explains a failure only when tier 1 failed; otherwise it's context.
  for (const note of tier1.notes)
    await append(
      "judge",
      `tier 1 ${tier1.verdict === "fail" ? "fail" : "note"}: ${oneLine(note)}`,
    );
  for (const p of tier1.protected)
    await append(
      "judge",
      `protected: ${protectedDetail(p)}${wasAllowed(p) ? " (allowed at build)" : ""}`,
    );
  const risk = await judgeRisk({
    repoPath,
    base: tier1.mergeBase,
    head,
    card: task.card,
    sensitive: assembly.stop_and_ask.flatMap((s) =>
      typeof s === "string" ? [] : s.touches,
    ),
  });
  if (risk.effective !== risk.card)
    await append(
      "judge",
      `risk raised to ${risk.effective} from the card's ${risk.card} at the judge: ${risk.reasons.join("; ")}`,
    );

  const record: JudgeRecord = {
    task: id,
    round,
    verdict: "passed",
    head,
    tree: await treeOf(repoPath, head),
    base: tier1.mergeBase,
    tier1: {
      verdict: tier1.verdict,
      checks: tier1.checks,
      protected: tier1.protected,
      notes: tier1.notes,
    },
    risk,
  };
  let why = "";
  const asks: string[] = [];

  if (tier1.verdict === "needs-human") {
    // A change to what judges it goes to a person; tier 2 doesn't run.
    record.verdict = "needs a human";
    why = `${tier1.protected.filter((p) => !wasAllowed(p)).length} protected change(s)`;
  } else if (tier1.verdict === "fail") {
    // Fix the deterministic failures before paying for a review.
    record.verdict = round > MAX_ROUNDS ? "needs a human" : "failed";
    why = `tier 1 failed${round > MAX_ROUNDS ? ` in round ${round}` : ""}`;
  } else if (tier1.changedFiles === 0) {
    // Nothing was built, so nothing on the card is done. The pilot's T-0010
    // passed an empty diff with three criteria unmet; no review is paid for.
    record.verdict = round > MAX_ROUNDS ? "needs a human" : "failed";
    why = `the change is empty: no file differs from the base, and the card has ${task.card.acceptance.length} acceptance item(s)`;
    for (const a of task.card.acceptance)
      await append("judge", `acceptance ${a.id}: unmet — the change is empty`);
  } else {
    const profile = await buildContext(repoPath)
      .profile()
      .catch(() => null);
    // The prove beat (or the deferred run above) wrote it; the runtime only.
    // A missing one is reviewed as a failed proof of the assembly's kind, so
    // the before check still runs and fails closed; an unreadable one stops.
    const proofFile = `${TASKS_DIR}/${id}/proof/proof.json`;
    let proof: ProofRecord;
    try {
      proof = JSON.parse(
        await readFile(join(repoPath, proofFile), "utf8"),
      ) as ProofRecord;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT")
        throw new TaskError(
          `can't read ${proofFile}: ${(err as Error).message}`,
        );
      await append(
        "judge",
        `no proof record at ${proofFile}; the review sees no proof`,
      );
      proof = {
        task: id,
        kind: assembly.proof,
        passed: false,
        lines: [`no proof record was found at ${proofFile}`],
      };
    }
    const plan = reviewPlan({
      risk: risk.effective,
      size: await changeSize(
        repoPath,
        tier1.mergeBase,
        head,
        assembly.stop_and_ask.flatMap((s) =>
          typeof s === "string" ? [] : s.touches,
        ),
      ),
      forced: options.model,
      strong: profile?.ai?.judge_model,
      small: profile?.ai?.judge_small_model,
    });
    const review = (ai: AiClient, model: string) =>
      (options.review ?? reviewLocal)({
        repoPath,
        ai,
        model,
        effort: plan.effort,
        card: task.card,
        decisions: allowedDecisions(task),
        proof,
        tier1: tier1.checks,
        base: tier1.mergeBase,
        head,
        round,
        usageDate: (options.now ?? new Date()).toISOString().slice(0, 10),
        log,
      });
    const full = (model = plan.model) =>
      review(
        // The CLI transport's own call limit fires first and stops the task;
        // this one bounds the API path, a minute later. One retry: a call
        // that failed for a passing reason is worth exactly one more.
        options.ai ??
          createAiClient({
            timeoutMs: (callTimeoutMinutes() + 1) * 60_000,
            maxRetries: 1,
          }),
        model,
      );
    const fastModel = profile?.ai?.judge_small_model ?? FAST_REVIEW_MODEL;
    let outcome: ReviewOutcome;
    try {
      if (isFastPath(task.card, risk.effective)) {
        try {
          outcome = await review(
            options.fastAi ??
              createAiClient({
                timeoutMs: FAST_REVIEW_TIMEOUT_MS,
                maxRetries: 0,
              }),
            options.model ?? fastModel,
          );
        } catch (err) {
          // The run's budget ran out: the full review would only be killed too.
          if (err instanceof CallTimeoutError) throw err;
          await append(
            "judge",
            `fast review (${fastModel}, ${FAST_REVIEW_TIMEOUT_MS / 60_000} min) didn't finish: ${oneLine((err as Error).message, 120)}; escalating to the full review`,
          );
          // The smaller model already had its turn.
          outcome = await full(
            options.model ?? profile?.ai?.judge_model ?? JUDGE_DEFAULT_MODEL,
          );
        }
      } else {
        log(`review: ${plan.model} at ${plan.effort} effort (${plan.why})`);
        outcome = await full();
      }
    } catch (err) {
      // Said in the ledger with what the call said, so a crashed review isn't
      // just "next: judge" with nothing to go on; the round is judged again.
      if (!(err instanceof CallTimeoutError))
        await append(
          "judge",
          `review round ${round} didn't finish: ${oneLine((err as Error).message, 600)}`,
        );
      throw err;
    }
    const r = outcome.result;
    record.review = {
      verdict: outcome.verdict,
      body: outcome.body,
      model: r.model,
      ...(r.effort ? { effort: r.effort } : {}),
      plan: plan.why,
      blocking: r.blocking,
      suggestions: r.suggestions,
      acceptance: r.acceptance,
      unreviewed: r.unreviewed,
      usage: r.usage,
    };
    await append(
      "judge",
      `review round ${round}: ${outcome.verdict}; ${r.blocking.length} blocking, ${r.suggestions.length} suggestion(s) (${r.model}${r.effort ? `, ${r.effort} effort` : ""}) · ${r.usage.tokens} tokens · $${r.usage.costUsd.toFixed(2)}`,
    );
    for (const f of r.blocking)
      await append(
        "judge",
        `blocking ${f.kind}${f.acceptance_id ? ` (${f.acceptance_id})` : ""} ${f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}— ${oneLine(f.title, 160)} · repro: ${oneLine(f.repro)}${f.fix ? ` · fix: ${oneLine(f.fix, 200)}` : ""}`,
      );
    for (const a of r.acceptance)
      await append(
        "judge",
        `acceptance ${a.id}: ${a.status}${a.note ? ` — ${oneLine(a.note, 200)}` : ""}`,
      );
    if (r.before)
      await append(
        "judge",
        `before proof: ${r.before.shows_defect ? "shows the defect" : "doesn't show the defect"}${r.before.note ? ` — ${oneLine(r.before.note, 200)}` : ""}`,
      );
    const unverified = unverifiedCriteria(task.card, r.acceptance);
    for (const u of unverified.filter(
      (u) => !r.acceptance.some((a) => a.id === u.id),
    ))
      await append("judge", `acceptance ${u.id}: unverified — ${u.note}`);
    // An unmet criterion blocks whatever the review's verdict says.
    const unmet = task.card.acceptance.filter((c) =>
      r.acceptance.some((a) => a.id === c.id && a.status === "unmet"),
    );
    // The review leaves a round needing a person when a criterion is
    // unverified; that's decided below, with the reason, so here it passes.
    const onlyUnverified =
      outcome.verdict === "needs-human" &&
      r.blocking.length === 0 &&
      r.unreviewed.length === 0;
    if (outcome.verdict === "request-changes") {
      record.verdict = "failed";
      why = `${r.blocking.length} blocking`;
    } else if (unmet.length > 0) {
      record.verdict = round > MAX_ROUNDS ? "needs a human" : "failed";
      why = `${unmet.length} acceptance item(s) unmet: ${unmet.map((c) => c.id).join(", ")}`;
    } else if (outcome.verdict === "approve" || onlyUnverified)
      record.verdict = "passed";
    else {
      record.verdict = "needs a human";
      why =
        r.blocking.length > 0
          ? `${r.blocking.length} blocking after ${MAX_ROUNDS} rounds`
          : `the reviewer wasn't shown ${r.unreviewed.join(", ")}`;
    }
    // A round sent back to build is judged again; any other never passes an
    // unverified criterion without a person, at any autonomy level: an
    // unverified criterion is one nobody showed is done.
    if (unverified.length > 0 && record.verdict !== "failed") {
      const detail = unverified
        .map((u) => `${u.id} (${oneLine(u.note, 200)})`)
        .join("; ");
      if (!allowed.has(`unverified_acceptance: ${detail}`)) {
        const level = await autonomyFor(repoPath, task.card);
        if (record.verdict === "needs a human")
          asks.push(`judge: ${why}; look at the change`);
        asks.push(`unverified_acceptance: ${detail}`);
        const reason = `${unverified.length} acceptance item(s) unverified at autonomy ${level}`;
        why = record.verdict === "needs a human" ? `${why}; ${reason}` : reason;
        record.verdict = "needs a human";
      }
    }
  }

  const text = `${JSON.stringify(record, null, 2)}\n`;
  await mkdir(join(repoPath, TASKS_DIR, id, "judge"), { recursive: true });
  await writeFile(recordPath(repoPath, id, round), text, "utf8");
  if (record.verdict === "needs a human" && asks.length === 0)
    asks.push(`judge: ${why}; look at the change`);
  for (const ask of asks) await append("stop", `asked: ${ask}`);
  await append(
    "timeline",
    `judge ${record.verdict} · round ${round} · head ${head.slice(0, 12)}${why ? ` · ${why}` : ""} · record sha256 ${sha256(text)}`,
  );
  task = await loadTask(repoPath, id);
  return { task, record };
}
