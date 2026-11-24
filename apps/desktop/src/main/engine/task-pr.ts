// A task's PR on GitHub, live: open, merged or closed, draft, mergeable, and
// the check runs on its head. Read only for a person signed in to GitHub in
// the app, through `githubToken()` with their token as the explicit one (the
// same path as the Now view's CI line), and given up after a few seconds so
// the detail never waits on it. The PR is the one the task's ledger records.
// Read-only: merging from the shell comes later, behind the decider's gate.
import {
  githubToken,
  Octokit,
  QUIET_LOG,
  resolveRepoSlug,
} from "@arynbht/rivetari-engine";

import type { TaskPrState } from "../../shared/ipc";

export interface PullInfo {
  state: string;
  merged: boolean;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string;
  headSha: string;
}

export interface PrCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
}

export interface PrClient {
  pull(owner: string, repo: string, number: number): Promise<PullInfo>;
  checkRuns(owner: string, repo: string, ref: string): Promise<PrCheckRun[]>;
}

export interface PrDeps {
  resolveRepoSlug: typeof resolveRepoSlug;
  githubToken: typeof githubToken;
  client: (token: string) => PrClient;
}

/** A read that takes longer than this is given up, and the detail says so. */
const PR_TIMEOUT_MS = 10_000;

const octokitClient = (token: string): PrClient => {
  const octokit = new Octokit({ auth: token, log: QUIET_LOG });
  const request = () => ({ signal: AbortSignal.timeout(PR_TIMEOUT_MS) });
  return {
    async pull(owner, repo, number) {
      const { data } = await octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: number,
        request: request(),
      });
      return {
        state: data.state,
        merged: data.merged,
        draft: data.draft ?? false,
        mergeable: data.mergeable,
        mergeableState: data.mergeable_state,
        headSha: data.head.sha,
      };
    },
    async checkRuns(owner, repo, ref) {
      const { data } = await octokit.rest.checks.listForRef({
        owner,
        repo,
        ref,
        per_page: 100,
        request: request(),
      });
      return data.check_runs;
    },
  };
};

const prDeps: PrDeps = {
  resolveRepoSlug,
  githubToken,
  client: octokitClient,
};

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** The PR's state in one line, as the detail heads it. */
function summary(pull: PullInfo, number: number): string {
  if (pull.merged) return `PR #${number} is merged`;
  if (pull.state === "closed") return `PR #${number} was closed unmerged`;
  const mergeable =
    pull.mergeable === null
      ? "GitHub is still working out whether it can merge"
      : pull.mergeable
        ? `mergeable (${pull.mergeableState})`
        : `not mergeable (${pull.mergeableState})`;
  return `PR #${number} is open${pull.draft ? " as a draft" : ""}, ${mergeable}`;
}

/** Task's PR `pr` (from its ledger) as GitHub has it now, or why it isn't shown. */
export async function prState(
  repoPath: string,
  pr: { number: number; url: string } | null,
  signedInToken: string | null,
  deps: PrDeps = prDeps,
): Promise<TaskPrState> {
  const none = (state: TaskPrState["state"], detail: string): TaskPrState => ({
    state,
    number: pr?.number ?? null,
    draft: null,
    mergeable: null,
    mergeableState: null,
    headSha: null,
    checks: [],
    detail,
  });
  if (!pr) return none("none", "no PR yet");
  if (!signedInToken)
    return none("signed-out", "sign in to see the PR's state and checks");
  const slug = await deps.resolveRepoSlug(repoPath);
  if (!slug)
    return none(
      "unavailable",
      "this repo has no GitHub origin to read the PR from",
    );
  const token = await deps.githubToken(repoPath, signedInToken);
  if (!token)
    return none("signed-out", "sign in to see the PR's state and checks");
  try {
    const client = deps.client(token.token);
    const pull = await client.pull(slug.owner, slug.repo, pr.number);
    const runs = await client.checkRuns(slug.owner, slug.repo, pull.headSha);
    return {
      state: pull.merged
        ? "merged"
        : pull.state === "closed"
          ? "closed"
          : "open",
      number: pr.number,
      draft: pull.draft,
      mergeable: pull.mergeable,
      mergeableState: pull.mergeableState,
      headSha: pull.headSha,
      checks: runs.map((r) => ({
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        headSha: r.head_sha,
      })),
      detail: summary(pull, pr.number),
    };
  } catch (err) {
    return none("unavailable", `the PR couldn't be read: ${message(err)}`);
  }
}
