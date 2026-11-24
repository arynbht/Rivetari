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
  decideAfterReview,
  decideBeforeReview,
  reviewRound,
} from "./decide.js";
import { type ProtectedFinding, protectedDetail } from "./protected.js";
import {
  type CarriedVerdict,
  type ReviewOutcome,
  reviewLocal,
  treeOf,
} from "./review.js";
import type { ReviewPlan } from "./review-plan.js";
import { type JudgedRisk, judgeRisk } from "./risk-check.js";
import { runTier1, type Tier1Options, type Tier1Result } from "./tier1.js";
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
  // A change to what judges it goes to a person and tier 2 doesn't run; a
  // tier 1 failure or an empty change goes back before paying for a review.
  let decision = decideBeforeReview({
    tier1,
    pendingProtected: tier1.protected.filter((p) => !wasAllowed(p)).length,
    card: task.card,
    round,
  });
  if (decision && tier1.verdict === "pass") {
    for (const a of task.card.acceptance)
      await append("judge", `acceptance ${a.id}: unmet — the change is empty`);
  } else if (!decision) {
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
    let outcome: ReviewOutcome;
    let plan: ReviewPlan;
    try {
      ({ outcome, plan } = await reviewRound({
        repoPath,
        card: task.card,
        risk: risk.effective,
        base: tier1.mergeBase,
        head,
        round,
        sensitive: assembly.stop_and_ask.flatMap((s) =>
          typeof s === "string" ? [] : s.touches,
        ),
        proof,
        decisions: allowedDecisions(task),
        tier1: tier1.checks,
        models: profile?.ai,
        model: options.model,
        ai: options.ai,
        fastAi: options.fastAi,
        review: options.review,
        usageDate: (options.now ?? new Date()).toISOString().slice(0, 10),
        log,
        onEscalate: async (message) => {
          await append("judge", message);
        },
      }));
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
    decision = await decideAfterReview({
      card: task.card,
      round,
      outcome,
      allowed,
      autonomy: () => autonomyFor(repoPath, task.card),
    });
    for (const u of decision.unverified.filter(
      (u) => !r.acceptance.some((a) => a.id === u.id),
    ))
      await append("judge", `acceptance ${u.id}: unverified — ${u.note}`);
  }
  if (!decision) throw new TaskError("the judge round reached no decision");
  record.verdict = decision.verdict;
  const { why, asks } = decision;

  const text = `${JSON.stringify(record, null, 2)}\n`;
  await mkdir(join(repoPath, TASKS_DIR, id, "judge"), { recursive: true });
  await writeFile(recordPath(repoPath, id, round), text, "utf8");
  for (const ask of asks) await append("stop", `asked: ${ask}`);
  await append(
    "timeline",
    `judge ${record.verdict} · round ${round} · head ${head.slice(0, 12)}${why ? ` · ${why}` : ""} · record sha256 ${sha256(text)}`,
  );
  task = await loadTask(repoPath, id);
  return { task, record };
}
