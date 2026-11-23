// GitHub Actions minutes, counted the way GitHub bills them: per job, each
// rounded up to a whole minute, skipped jobs free. The run-level timing
// endpoint reports nothing billable on a public repo and is being retired,
// so jobs are the one source that works everywhere.
import type { GitHubClient } from "../context.js";

export interface CiMinutes {
  minutes: number;
  /** Completed workflow runs counted. */
  runs: number;
  /** True when there were runs it didn't count (the API's cap, or `maxLookups`). */
  partial: boolean;
}

interface JobTimes {
  started_at?: string | null;
  completed_at?: string | null;
  conclusion?: string | null;
}

/** Minutes a set of jobs bills: each job rounded up, skipped or instant ones free. */
export function jobMinutes(jobs: readonly JobTimes[]): number {
  let minutes = 0;
  for (const job of jobs) {
    if (job.conclusion === "skipped" || !job.started_at || !job.completed_at)
      continue;
    const ms = Date.parse(job.completed_at) - Date.parse(job.started_at);
    if (ms > 0) minutes += Math.ceil(ms / 60_000);
  }
  return minutes;
}

/** Every attempt's jobs: a re-run bills again. */
async function runMinutes(gh: GitHubClient, runId: number): Promise<number> {
  const jobs = await gh.octokit.paginate(
    gh.octokit.rest.actions.listJobsForWorkflowRun,
    {
      owner: gh.owner,
      repo: gh.repo,
      run_id: runId,
      filter: "all",
      per_page: 100,
    },
  );
  return jobMinutes(jobs);
}

interface RunRef {
  id: number;
  run_attempt?: number | undefined;
  status: string | null;
}

/** Minutes for each run, a few at a time; `known` holds runs already counted. */
async function countRuns(
  gh: GitHubClient,
  runs: readonly RunRef[],
  known: Map<string, number>,
  maxLookups: number,
): Promise<CiMinutes> {
  const completed = runs.filter((r) => r.status === "completed");
  const key = (r: RunRef) => `${r.id}/${r.run_attempt ?? 1}`;
  const todo = completed.filter((r) => !known.has(key(r)));
  const lookups = todo.slice(0, maxLookups);
  let next = 0;
  const worker = async () => {
    while (next < lookups.length) {
      const run = lookups[next++]!;
      known.set(key(run), await runMinutes(gh, run.id));
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  const counted = completed.filter((r) => known.has(key(r)));
  return {
    minutes: counted.reduce((sum, r) => sum + known.get(key(r))!, 0),
    runs: counted.length,
    partial: counted.length < completed.length,
  };
}

/**
 * The minutes a pull request's CI used: every completed workflow run on any
 * of its commits, so a branch pushed more than once counts every push.
 */
export async function prCiMinutes(
  gh: GitHubClient,
  pr: number,
): Promise<CiMinutes> {
  const { octokit, owner, repo } = gh;
  const commits = await octokit.paginate(octokit.rest.pulls.listCommits, {
    owner,
    repo,
    pull_number: pr,
    per_page: 100,
  });
  const runs = new Map<number, RunRef>();
  for (const { sha } of commits) {
    const found = await octokit.paginate(
      octokit.rest.actions.listWorkflowRunsForRepo,
      { owner, repo, head_sha: sha, per_page: 100 },
    );
    for (const run of found) runs.set(run.id, run);
  }
  return countRuns(gh, [...runs.values()], new Map(), Infinity);
}

/** The UTC calendar month `now` falls in, as YYYY-MM. */
export const ciMonth = (now: Date) => now.toISOString().slice(0, 7);

/**
 * The repo's CI minutes so far this calendar month (UTC). `known` carries
 * minutes for runs counted before (keyed `<run id>/<attempt>`) and gains the
 * new ones, so a caller that keeps it only looks up what's new; `maxLookups`
 * caps the job lookups on one call, for a token with a small rate limit.
 */
export async function monthCiMinutes(
  gh: GitHubClient,
  now: Date,
  options: { known?: Map<string, number>; maxLookups?: number } = {},
): Promise<CiMinutes & { month: string }> {
  const { octokit, owner, repo } = gh;
  const month = ciMonth(now);
  const runs: RunRef[] = [];
  let total = 0;
  // A filtered listing stops at 1,000 runs; past that the count is partial.
  for (let page = 1; page <= 10; page++) {
    const { data } = await octokit.rest.actions.listWorkflowRunsForRepo({
      owner,
      repo,
      created: `>=${month}-01`,
      status: "completed",
      per_page: 100,
      page,
    });
    total = data.total_count;
    runs.push(...data.workflow_runs);
    if (data.workflow_runs.length < 100) break;
  }
  const counted = await countRuns(
    gh,
    runs,
    options.known ?? new Map(),
    options.maxLookups ?? Infinity,
  );
  return {
    ...counted,
    partial: counted.partial || total > runs.length,
    month,
  };
}

/** The share of the budget at which doctor and the status issue warn. */
export const CI_BUDGET_WARN = 0.75;

/** The status issue's line on the month's CI minutes against the budget. */
export function ciBudgetLine(used: CiMinutes | null, budget: number): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  if (!used)
    return `CI minutes this month: couldn't be read from the Actions API (the token needs actions: read); budget ${fmt(budget)}.`;
  const share = used.minutes / budget;
  const mark = share >= 1 ? "⛔ " : share >= CI_BUDGET_WARN ? "⚠ " : "";
  return `${mark}CI minutes this month: ${used.partial ? "at least " : ""}${fmt(used.minutes)} of ${fmt(budget)} (${Math.round(share * 100)}%) over ${fmt(used.runs)} run(s).`;
}

/**
 * What the status issue appends for the month's CI minutes: nothing without
 * a budget, else the line. Job lookups are capped so a busy month can't
 * spend the token's hourly rate limit before the issue is written.
 */
export async function ciBudgetSection(
  ctx: { github(): Promise<GitHubClient | null> },
  budget: number | undefined,
  now: Date,
): Promise<string> {
  if (!budget) return "";
  const gh = await ctx.github().catch(() => null);
  const used = gh
    ? await monthCiMinutes(gh, now, { maxLookups: 500 }).catch(() => null)
    : null;
  return `\n\n${ciBudgetLine(used, budget)}`;
}
