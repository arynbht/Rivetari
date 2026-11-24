// The `rivetari/judge` check run: the judge's pass on one commit, posted as
// Rivetari's App so CI can skip what the judge already ran. Only an App can
// create check runs, and CI trusts this one only from the App it's told to.
import type { GitHubClient } from "../context.js";

export const JUDGE_CHECK_NAME = "rivetari/judge";

export interface JudgeCheckParams {
  /** The commit the judge passed. */
  head: string;
  task: string;
  round: number;
  /** sha256 of the judge's round record, as sealed in the ledger. */
  recordSha256: string;
  /** The ledger's chain head (the last entry's MAC) when the check is posted. */
  ledgerHash: string;
  /**
   * The judged head's tree (`git rev-parse <head>^{tree}`): a later head with
   * the same tree, such as a merge commit that brings nothing new, carries the
   * verdict.
   */
  tree?: string | undefined;
}

/**
 * Post a successful `rivetari/judge` check on the head commit, once: a
 * success already there for the same task is left alone. Returns its URL,
 * or null when there already was one.
 */
export async function postJudgeCheck(
  gh: GitHubClient,
  params: JudgeCheckParams,
): Promise<string | null> {
  const { octokit, owner, repo } = gh;
  const { data } = await octokit.rest.checks.listForRef({
    owner,
    repo,
    ref: params.head,
    check_name: JUDGE_CHECK_NAME,
    per_page: 100,
  });
  if (
    data.check_runs.some(
      (c) => c.conclusion === "success" && c.external_id === params.task,
    )
  )
    return null;
  const { data: created } = await octokit.rest.checks.create({
    owner,
    repo,
    name: JUDGE_CHECK_NAME,
    head_sha: params.head,
    external_id: params.task,
    status: "completed",
    conclusion: "success",
    output: {
      title: `Judge passed ${params.task} (round ${params.round})`,
      summary: [
        `The judge passed ${params.task} in round ${params.round} on \`${params.head}\`: lint, typecheck and tests ran on a clean clone of the base plus this change.`,
        "",
        `- Judge record sha256: \`${params.recordSha256}\``,
        `- Ledger hash: \`${params.ledgerHash}\``,
        ...(params.tree ? [`- Tree: \`${params.tree}\``] : []),
      ].join("\n"),
    },
  });
  return created.html_url ?? null;
}

/**
 * Carry a green `rivetari/judge` check from `from` to `head`, which the
 * caller has checked has the identical tree: what the judge ran on is
 * byte for byte what `head` holds, so CI may skip on it the same way. The
 * new check says where it came from. Returns its URL, or null when `from`
 * has no green check or `head` already has one.
 */
export async function carryJudgeCheck(
  gh: GitHubClient,
  params: { from: string; head: string; tree: string },
): Promise<string | null> {
  const { octokit, owner, repo } = gh;
  const runs = async (ref: string) =>
    (
      await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref,
        check_name: JUDGE_CHECK_NAME,
        per_page: 100,
      })
    ).data.check_runs.filter((c) => c.conclusion === "success");
  const source = (await runs(params.from))[0];
  if (!source || (await runs(params.head)).length > 0) return null;
  const { data: created } = await octokit.rest.checks.create({
    owner,
    repo,
    name: JUDGE_CHECK_NAME,
    head_sha: params.head,
    ...(source.external_id ? { external_id: source.external_id } : {}),
    status: "completed",
    conclusion: "success",
    output: {
      title: `${source.output.title ?? "Judge passed"} (carried: identical tree)`,
      summary: [
        `Carried from \`${params.from}\`: this commit's tree \`${params.tree}\` is identical to the judged one, so the judge's pass holds for it unchanged.`,
        "",
        source.output.summary ?? "",
      ].join("\n"),
    },
  });
  return created.html_url ?? null;
}
