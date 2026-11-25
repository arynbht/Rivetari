// `rivetari review`: judge tier 2 on a local branch or a GitHub pull request,
// with the two-round limit and posting as a single PR review.
import {
  type AiClient,
  carryJudgeCheck,
  type Effort,
  Octokit,
  QUIET_LOG,
  resolveRepoSlug,
} from "@arynbht/rivetari-engine";

import { judgeGit } from "./git.js";
import type { ReviewProof } from "./tier2.js";
import type { Card } from "../task/card.js";
import type { AllowedDecision } from "../task/tasks.js";
import type { Tier1Checks } from "./tier1-criteria.js";
import {
  type Finding,
  renderReview,
  REVIEW_MARKER,
  runTier2,
  type Tier2Result,
} from "./tier2.js";

/** After this many rounds, remaining blocking findings go to a person. */
export const MAX_ROUNDS = 2;

export type ReviewVerdict = "approve" | "request-changes" | "needs-human";

export interface ReviewOutcome {
  verdict: ReviewVerdict;
  round: number;
  result: Tier2Result;
  body: string;
  /** Set when the review was posted to a pull request. */
  posted?: { url: string; event: string } | undefined;
  /** Set when an earlier verdict on the same tree was carried instead of reviewing. */
  carried?: CarriedVerdict | undefined;
  /** What became of carrying the `rivetari/judge` check, when it was tried. */
  check?: string | undefined;
}

export interface ReviewOptions {
  repoPath: string;
  ai: AiClient;
  model?: string | undefined;
  card?: Card | undefined;
  decisions?: readonly AllowedDecision[] | undefined;
  /** The task's proof, so criteria are checked against it as well as the diff. */
  proof?: ReviewProof | undefined;
  /** Tier 1's checks on the same change, when the judge ran them this round. */
  tier1?: Tier1Checks | undefined;
  effort?: Effort | undefined;
  usageDate?: string | undefined;
  log?: ((line: string) => void) | undefined;
}

/**
 * The verdict for a round: blocking findings past the round limit need a
 * person, and so does a change with files the reviewer wasn't shown or a
 * criterion nobody verified: the judge never passes what it couldn't confirm.
 */
export function roundVerdict(
  result: Tier2Result,
  round: number,
): ReviewVerdict {
  if (result.verdict === "approve")
    return result.unreviewed.length > 0 || (result.unverified?.length ?? 0) > 0
      ? "needs-human"
      : "approve";
  return round > MAX_ROUNDS ? "needs-human" : "request-changes";
}

/** A commit's tree: two commits with the same one hold the same files, byte for byte. */
export async function treeOf(repoPath: string, rev: string): Promise<string> {
  return (await judgeGit(repoPath).revparse([`${rev}^{tree}`])).trim();
}

/** An earlier verdict on a head with the same tree, which a review can carry. */
export interface CarriedVerdict {
  verdict: ReviewVerdict;
  /** The head it was given on. */
  from: string;
  /** Where it came from: a review on this PR, or a task's judge round. */
  source: string;
  round: number;
  /** The earlier review's text. */
  body: string;
  url?: string | undefined;
}

/** A task judge's passed round whose head has the tree, when the caller can look. */
export type FindJudged = (
  tree: string,
  head: string,
) => Promise<CarriedVerdict | null>;

const MARK = /^<!-- rivetari-judge-review round=(\d+)(.*?)-->/;

/** What an earlier review's marker and heading say about it. */
export function readMarker(body: string): {
  round: number;
  verdict: ReviewVerdict | null;
  tree: string | null;
  carried: boolean;
} | null {
  const m = MARK.exec(body);
  if (!m) return null;
  const rest = m[2] ?? "";
  const said = /\bverdict=(approve|request-changes|needs-human)\b/.exec(
    rest,
  )?.[1] as ReviewVerdict | undefined;
  // Reviews from before the marker said it: the heading does.
  const heading =
    /### Rivetari judge · round \d+ · (approve|needs a human|request changes|\d+ blocking)/.exec(
      body,
    )?.[1];
  const verdict =
    said ??
    (heading === "approve"
      ? "approve"
      : heading === "needs a human"
        ? "needs-human"
        : heading
          ? "request-changes"
          : null);
  return {
    round: Number(m[1]),
    verdict,
    tree: /\btree=([0-9a-f]{40,64})\b/.exec(rest)?.[1] ?? null,
    carried: /\bcarried=/.test(rest),
  };
}

/** A result for a review that carried a verdict instead of running. */
function carriedResult(verdict: ReviewVerdict): Tier2Result {
  return {
    verdict: verdict === "request-changes" ? "request-changes" : "approve",
    blocking: [],
    suggestions: [],
    acceptance: [],
    unreviewed: [],
    model: "carried",
    calls: 0,
    usage: { tokens: 0, costUsd: 0 },
    packed: {
      files: [],
      omitted: [],
      lines: new Map(),
      agents: null,
      constraints: null,
    },
  };
}

/** The carried review's text: what it carried and from where, then the earlier review. */
export function renderCarried(
  carried: CarriedVerdict,
  round: number,
  tree: string,
): string {
  const result = carriedResult(carried.verdict);
  const head = renderReview(result, round, carried.verdict, {
    tree,
    carried: { from: carried.from, url: carried.url },
  })
    .split("\n")
    .slice(0, 4);
  return [
    ...head,
    `Earlier verdict: ${carried.verdict} (${carried.source}). Run \`rivetari review --pr <n> --fresh\` to review this head anew.`,
    "",
    "<details><summary>The carried review</summary>",
    "",
    carried.body.replace(MARK, "").trim(),
    "",
    "</details>",
  ].join("\n");
}

/** Review a local change: the diff from merge-base(base, head) to head. */
export async function reviewLocal(
  options: ReviewOptions & {
    base: string;
    head?: string | undefined;
    round?: number;
  },
): Promise<ReviewOutcome> {
  const git = judgeGit(options.repoPath);
  const head = (await git.revparse([options.head ?? "HEAD"])).trim();
  const base = (await git.raw(["merge-base", options.base, head])).trim();
  const result = await runTier2({ ...options, base, head });
  const round = options.round ?? 1;
  const verdict = roundVerdict(result, round);
  return { verdict, round, result, body: renderReview(result, round, verdict) };
}

/**
 * Review a pull request: fetch its head, diff it against its base, count the
 * judge's earlier rounds on it, and (with `post`) leave one review — inline
 * comments for blocking findings on lines in the diff, suggestions in the body.
 */
export async function reviewPullRequest(
  options: ReviewOptions & {
    pr: number;
    token: string;
    post: boolean;
    /** Review the head even when an earlier verdict on its tree could carry. */
    fresh?: boolean | undefined;
    /** Look for a task judge's pass on the same tree (the CLI wires the task store in). */
    findJudged?: FindJudged | undefined;
  },
): Promise<ReviewOutcome> {
  const slug = await resolveRepoSlug(options.repoPath);
  if (!slug)
    throw new Error("can't tell which GitHub repo this is (no origin remote)");
  const octokit = new Octokit({ auth: options.token, log: QUIET_LOG });
  const { owner, repo } = slug;
  const { data: pr } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: options.pr,
  });
  const reviews = await octokit.paginate(octokit.rest.pulls.listReviews, {
    owner,
    repo,
    pull_number: options.pr,
  });
  const marked = reviews.flatMap((r) => {
    const mark = r.body?.includes(REVIEW_MARKER) ? readMarker(r.body) : null;
    return mark ? [{ review: r, mark }] : [];
  });
  // Anyone who can review the PR can write a marker, so only the judge's own
  // reviews (this token's identity) can carry a verdict. A token that can't
  // say who it is (an App installation) carries none from the PR.
  const me = await octokit.rest.users
    .getAuthenticated()
    .then((r) => r.data.login)
    .catch(() => null);
  const mine = ownReviews(marked, me);

  const git = judgeGit(options.repoPath);
  const ref = `refs/rivetari/pr-${options.pr}`;
  await git.raw([
    "fetch",
    "--quiet",
    "origin",
    `+pull/${options.pr}/head:${ref}`,
  ]);
  let head: string;
  let tree: string;
  let carried: CarriedVerdict | null = null;
  let result: Awaited<ReturnType<typeof runTier2>> | null = null;
  try {
    await git.raw(["fetch", "--quiet", "origin", pr.base.ref]);
    head = (await git.revparse([ref])).trim();
    // GitHub moves pull/<n>/head a moment after a push: right after one, the
    // ref can still be the old head. Review the commit the API says is the
    // PR's head, never a stale one.
    if (head !== pr.head.sha) {
      await git
        .raw(["fetch", "--quiet", "origin", `+${pr.head.sha}:${ref}`])
        .catch(() => undefined);
      head = (await git.revparse([ref])).trim();
      if (head !== pr.head.sha)
        throw new Error(
          `couldn't fetch PR #${options.pr}'s head ${pr.head.sha.slice(0, 12)} (got ${head.slice(0, 12)}); try again in a moment`,
        );
    }
    tree = await treeOf(options.repoPath, head);
    if (!options.fresh)
      carried = await carriedFor(options, mine, head, tree, marked);
    if (!carried) {
      const base = (
        await git.raw(["merge-base", `origin/${pr.base.ref}`, head])
      ).trim();
      result = await runTier2({ ...options, base, head });
    }
  } finally {
    // The ref only kept the PR's commits reachable while they were reviewed.
    await git.raw(["update-ref", "-d", ref]).catch(() => undefined);
  }

  // A carried review isn't a round: nothing was reviewed again.
  const round =
    marked.filter((m) => !(m.mark.carried && mine.includes(m))).length + 1;
  const from = carried?.from ?? "";
  if (carried) {
    options.log?.(
      `head ${head.slice(0, 12)} has the tree reviewed at ${carried.from.slice(0, 12)}; carrying its verdict (${carried.verdict})`,
    );
    const outcome: ReviewOutcome = {
      verdict: carried.verdict,
      round: carried.round,
      result: carriedResult(carried.verdict),
      body: renderCarried(carried, carried.round, tree),
      carried,
    };
    if (!options.post) return outcome;
    await postReview(
      octokit,
      { owner, repo, pr: options.pr, head },
      outcome,
      [],
    );
    // What the judge passed is byte for byte what this head holds, so CI may
    // skip on it here too. Only an App can create check runs; anything else
    // is refused, and that costs CI time, never the review.
    if (carried.verdict === "approve")
      outcome.check = await carryJudgeCheck(
        { octokit, owner, repo, cached: (_key, fn) => fn() },
        { from: carried.from, head, tree },
      ).then(
        (url) =>
          url
            ? `judge check carried: ${url}`
            : `no rivetari/judge check to carry from ${from.slice(0, 12)}, or this head has one`,
        (err: Error) =>
          `judge check not carried: ${err.message.replace(/\s+/g, " ").slice(0, 200)}`,
      );
    return outcome;
  }
  if (!result) throw new Error("the review didn't run");
  const reviewed = result;
  const verdict = roundVerdict(reviewed, round);
  const body = renderReview(reviewed, round, verdict, { tree });
  const outcome: ReviewOutcome = { verdict, round, result: reviewed, body };
  if (!options.post) return outcome;

  const comments = reviewed.blocking
    .filter((f): f is Finding & { line: number } =>
      Boolean(f.line && reviewed.packed.lines.get(f.file)?.has(f.line)),
    )
    .map((f) => ({
      path: f.file,
      line: f.line,
      side: "RIGHT" as const,
      body: `**${f.kind}: ${f.title}**\n\n${f.detail}${f.repro ? `\n\n**Repro:** ${f.repro}` : ""}${f.fix ? `\n\n**Fix:** ${f.fix}` : ""}`,
    }));
  await postReview(
    octokit,
    { owner, repo, pr: options.pr, head },
    outcome,
    comments,
  );
  return outcome;
}

type ReviewComment = {
  path: string;
  line: number;
  side: "RIGHT";
  body: string;
};

interface MarkedReview {
  review: {
    commit_id: string | null;
    body?: string;
    html_url: string;
    user?: { login: string } | null;
  };
  mark: NonNullable<ReturnType<typeof readMarker>>;
}

/** The marked reviews written by `me`; none when who `me` is isn't known. */
export function ownReviews<T extends MarkedReview>(
  marked: T[],
  me: string | null,
): T[] {
  return me ? marked.filter((m) => m.review.user?.login === me) : [];
}

/**
 * An earlier verdict this head can carry: the latest of `marked` (the
 * judge's own reviews) at a commit with the same tree, else a task judge's
 * pass on it. None once this head has any review of its own (`all`), since
 * asking again on it means review anew. The tree is always git's for the
 * reviewed commit: a marker's `tree=` is anyone's to write.
 */
export async function carriedFor(
  options: ReviewOptions & { findJudged?: FindJudged | undefined },
  marked: MarkedReview[],
  head: string,
  tree: string,
  all: MarkedReview[] = marked,
): Promise<CarriedVerdict | null> {
  if (all.some((m) => m.review.commit_id === head)) return null;
  for (const { review, mark } of [...marked].reverse()) {
    if (!review.commit_id || !mark.verdict) continue;
    const at = await treeOf(options.repoPath, review.commit_id).catch(
      () => null,
    );
    if (at === tree)
      return {
        verdict: mark.verdict,
        from: review.commit_id,
        source: `review round ${mark.round} on this PR`,
        round: mark.round,
        body: review.body ?? "",
        url: review.html_url,
      };
  }
  return options.findJudged ? options.findJudged(tree, head) : null;
}

/** Post one review on the PR, keeping the verdict where GitHub allows it. */
async function postReview(
  octokit: Octokit,
  at: { owner: string; repo: string; pr: number; head: string },
  outcome: ReviewOutcome,
  comments: ReviewComment[],
): Promise<void> {
  const event =
    outcome.verdict === "approve"
      ? "APPROVE"
      : outcome.verdict === "request-changes"
        ? "REQUEST_CHANGES"
        : "COMMENT";

  const attempts: {
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
    comments: ReviewComment[];
  }[] = [
    { event, comments },
    // An inline comment on a line GitHub won't accept: keep the verdict, move
    // the findings into the body.
    { event, comments: [] },
    // GitHub refuses approve/request-changes on your own PR: say it in a comment.
    { event: "COMMENT", comments },
    { event: "COMMENT", comments: [] },
  ];
  let lastError: unknown;
  for (const attempt of attempts) {
    try {
      const { data } = await octokit.rest.pulls.createReview({
        owner: at.owner,
        repo: at.repo,
        pull_number: at.pr,
        commit_id: at.head,
        event: attempt.event,
        body: outcome.body,
        comments: attempt.comments,
      });
      outcome.posted = { url: data.html_url, event: attempt.event };
      return;
    } catch (err) {
      lastError = err;
      if ((err as { status?: number }).status !== 422) throw err;
    }
  }
  throw lastError;
}
