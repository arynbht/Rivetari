// A judge round's review and what the round decides from tier 1 and the
// review, with no ledger: the task judge writes what these return, and the
// judge eval scores it, so the verdict the eval measures is the one a task
// gets.
import {
  type AiClient,
  CallTimeoutError,
  callTimeoutMinutes,
  createAiClient,
} from "@arynbht/rivetari-engine";

import type { Card } from "../task/card.js";
import type { Risk } from "../task/risk.js";
import type { AllowedDecision } from "../task/tasks.js";
import {
  FAST_REVIEW_MODEL,
  FAST_REVIEW_TIMEOUT_MS,
  isFastPath,
} from "./fast-path.js";
import { MAX_ROUNDS, type ReviewOutcome, reviewLocal } from "./review.js";
import { changeSize, type ReviewPlan, reviewPlan } from "./review-plan.js";
import type { BaseTests } from "./base-tests.js";
import type { Tier1Checks } from "./tier1-criteria.js";
import type { Tier1Result } from "./tier1.js";
import {
  JUDGE_DEFAULT_MODEL,
  type ReviewProof,
  unverifiedCriteria,
} from "./tier2.js";

const oneLine = (s: string, n = 300) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

export interface ReviewRoundInput {
  repoPath: string;
  card: Card;
  /** The effective risk the judge derived. */
  risk: Risk;
  /** The merge-base and the judged head. */
  base: string;
  head: string;
  round: number;
  /** The repo's sensitive list (the assembly's stop-and-ask touches). */
  sensitive: readonly string[];
  proof: ReviewProof;
  decisions: readonly AllowedDecision[];
  tier1: Tier1Checks;
  /** Tier 1's run of the change's new tests on the base. */
  baseTests?: BaseTests | undefined;
  /** The profile's judge models, when it names them. */
  models?:
    | {
        judge_model?: string | undefined;
        judge_small_model?: string | undefined;
      }
    | null
    | undefined;
  /** One model for the review, past the risk-based choice. */
  model?: string | undefined;
  ai?: AiClient | undefined;
  fastAi?: AiClient | undefined;
  review?: typeof reviewLocal | undefined;
  usageDate?: string | undefined;
  log?: ((line: string) => void) | undefined;
  /** Told when the fast review didn't finish and the full one runs instead. */
  onEscalate?: ((message: string) => Promise<void>) | undefined;
}

/**
 * The round's review: the model and effort follow the derived risk and the
 * change's size; a fast-path card goes to the smaller model under a short
 * timeout first, and to the full review if that doesn't finish.
 */
export async function reviewRound(
  input: ReviewRoundInput,
): Promise<{ outcome: ReviewOutcome; plan: ReviewPlan }> {
  const log = input.log ?? (() => undefined);
  const plan = reviewPlan({
    risk: input.risk,
    size: await changeSize(
      input.repoPath,
      input.base,
      input.head,
      input.sensitive,
    ),
    forced: input.model,
    strong: input.models?.judge_model,
    small: input.models?.judge_small_model,
  });
  const review = (ai: AiClient, model: string) =>
    (input.review ?? reviewLocal)({
      repoPath: input.repoPath,
      ai,
      model,
      effort: plan.effort,
      card: input.card,
      decisions: input.decisions,
      proof: input.proof,
      tier1: input.tier1,
      baseTests: input.baseTests,
      base: input.base,
      head: input.head,
      round: input.round,
      usageDate: input.usageDate,
      log,
    });
  const full = (model = plan.model) =>
    review(
      // The CLI transport's own call limit fires first and stops the task;
      // this one bounds the API path, a minute later. One retry: a call
      // that failed for a passing reason is worth exactly one more.
      input.ai ??
        createAiClient({
          timeoutMs: (callTimeoutMinutes() + 1) * 60_000,
          maxRetries: 1,
        }),
      model,
    );
  const fastModel = input.models?.judge_small_model ?? FAST_REVIEW_MODEL;
  if (!isFastPath(input.card, input.risk)) {
    log(`review: ${plan.model} at ${plan.effort} effort (${plan.why})`);
    return { outcome: await full(), plan };
  }
  try {
    const outcome = await review(
      input.fastAi ??
        createAiClient({ timeoutMs: FAST_REVIEW_TIMEOUT_MS, maxRetries: 0 }),
      input.model ?? fastModel,
    );
    return { outcome, plan };
  } catch (err) {
    // The run's budget ran out: the full review would only be killed too.
    if (err instanceof CallTimeoutError) throw err;
    await input.onEscalate?.(
      `fast review (${fastModel}, ${FAST_REVIEW_TIMEOUT_MS / 60_000} min) didn't finish: ${oneLine((err as Error).message, 120)}; escalating to the full review`,
    );
    // The smaller model already had its turn.
    const outcome = await full(
      input.model ?? input.models?.judge_model ?? JUDGE_DEFAULT_MODEL,
    );
    return { outcome, plan };
  }
}

export type RoundVerdict = "passed" | "failed" | "needs a human";

export interface RoundDecision {
  verdict: RoundVerdict;
  /** Why it isn't a pass, for the verdict line; empty on a pass. */
  why: string;
  /** Stop-and-ask questions for a person, in the order they're asked. */
  asks: string[];
  /** The card's criteria nobody confirmed; empty before a review. */
  unverified: { id: string; note: string }[];
  /** Criteria the review marked unmet. */
  unmet: string[];
}

const sendBack = (round: number): RoundVerdict =>
  round > MAX_ROUNDS ? "needs a human" : "failed";

/**
 * The decision tier 1 makes on its own, or null when the review decides: a
 * protected change goes to a person, a tier 1 failure or an empty change goes
 * back to build without paying for a review.
 */
export function decideBeforeReview(input: {
  tier1: Pick<Tier1Result, "verdict" | "changedFiles">;
  /** Protected changes nobody allowed at build. */
  pendingProtected: number;
  card: Pick<Card, "acceptance">;
  round: number;
}): RoundDecision | null {
  const { tier1, round } = input;
  const decided = (verdict: RoundVerdict, why: string): RoundDecision => ({
    verdict,
    why,
    asks:
      verdict === "needs a human" ? [`judge: ${why}; look at the change`] : [],
    unverified: [],
    unmet: [],
  });
  if (tier1.verdict === "needs-human")
    return decided(
      "needs a human",
      `${input.pendingProtected} protected change(s)`,
    );
  if (tier1.verdict === "fail")
    return decided(
      sendBack(round),
      `tier 1 failed${round > MAX_ROUNDS ? ` in round ${round}` : ""}`,
    );
  // Nothing was built, so nothing on the card is done. The pilot's T-0010
  // passed an empty diff with three criteria unmet; no review is paid for.
  if (tier1.changedFiles === 0)
    return decided(
      sendBack(round),
      `the change is empty: no file differs from the base, and the card has ${input.card.acceptance.length} acceptance item(s)`,
    );
  return null;
}

/**
 * The decision after the review. An unmet criterion blocks whatever the
 * review's verdict says, and a round that isn't sent back never passes an
 * unverified criterion without a person, at any autonomy level, unless a
 * person already allowed exactly that.
 */
export async function decideAfterReview(input: {
  card: Pick<Card, "acceptance">;
  round: number;
  outcome: Pick<ReviewOutcome, "verdict"> & {
    result: Pick<
      ReviewOutcome["result"],
      "blocking" | "acceptance" | "unreviewed"
    >;
  };
  /** Stops a person allowed, as asked (`unverified_acceptance: …`). */
  allowed: ReadonlySet<string>;
  /** The task's autonomy level, read only when it's named. */
  autonomy: () => Promise<string>;
}): Promise<RoundDecision> {
  const { card, round, outcome } = input;
  const r = outcome.result;
  const unverified = unverifiedCriteria(card, r.acceptance);
  const unmet = card.acceptance
    .filter((c) =>
      r.acceptance.some((a) => a.id === c.id && a.status === "unmet"),
    )
    .map((c) => c.id);
  // The review leaves a round needing a person when a criterion is
  // unverified; that's decided below, with the reason, so here it passes.
  const onlyUnverified =
    outcome.verdict === "needs-human" &&
    r.blocking.length === 0 &&
    r.unreviewed.length === 0;
  let verdict: RoundVerdict = "passed";
  let why = "";
  if (outcome.verdict === "request-changes") {
    verdict = "failed";
    why = `${r.blocking.length} blocking`;
  } else if (unmet.length > 0) {
    verdict = sendBack(round);
    why = `${unmet.length} acceptance item(s) unmet: ${unmet.join(", ")}`;
  } else if (outcome.verdict !== "approve" && !onlyUnverified) {
    verdict = "needs a human";
    why =
      r.blocking.length > 0
        ? `${r.blocking.length} blocking after ${MAX_ROUNDS} rounds`
        : `the reviewer wasn't shown ${r.unreviewed.join(", ")}`;
  }
  const asks: string[] = [];
  // A round sent back to build is judged again; an unverified criterion is
  // one nobody showed is done.
  if (unverified.length > 0 && verdict !== "failed") {
    const detail = unverified
      .map((u) => `${u.id} (${oneLine(u.note, 200)})`)
      .join("; ");
    if (!input.allowed.has(`unverified_acceptance: ${detail}`)) {
      const level = await input.autonomy();
      if (verdict === "needs a human")
        asks.push(`judge: ${why}; look at the change`);
      asks.push(`unverified_acceptance: ${detail}`);
      const reason = `${unverified.length} acceptance item(s) unverified at autonomy ${level}`;
      why = verdict === "needs a human" ? `${why}; ${reason}` : reason;
      verdict = "needs a human";
    }
  }
  if (verdict === "needs a human" && asks.length === 0)
    asks.push(`judge: ${why}; look at the change`);
  return { verdict, why, asks, unverified, unmet };
}
