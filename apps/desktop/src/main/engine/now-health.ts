// The Now view's health strip: the autonomy level the profile configures,
// spend from history.jsonl and the open tasks' ledgers, the skills' lock and
// sync state, and main's CI on GitHub. Each part is read from the record that
// already answers it and fails on its own, so one unreadable part doesn't hide
// the rest. The effective autonomy level isn't read here: the runtime's ladder
// repairs its ledger view as it reads, and the shell doesn't write.
import {
  githubToken,
  loadProfile,
  Octokit,
  QUIET_LOG,
  resolveRepoSlug,
} from "@arynbht/rivetari-engine";
import {
  historyRows,
  parseAssembly,
  readLock,
  readState,
  skillsStatus,
  type TaskView,
} from "@arynbht/rivetari-runtime";

import type { NowCi, NowHealth } from "../../shared/ipc";

export interface HealthDeps {
  loadProfile: typeof loadProfile;
  historyRows: typeof historyRows;
  readLock: typeof readLock;
  readState: typeof readState;
  skillsStatus: typeof skillsStatus;
  now: () => Date;
}

const healthDeps: HealthDeps = {
  loadProfile,
  historyRows,
  readLock,
  readState,
  skillsStatus,
  now: () => new Date(),
};

const message = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

/** The history rows' dates are UTC days, as the close beat writes them. */
const utcDay = (at: Date) => at.toISOString().slice(0, 10);

export async function nowHealth(
  repoPath: string,
  views: TaskView[],
  deps: HealthDeps = healthDeps,
): Promise<NowHealth> {
  const open = views.filter((v) => !v.done);
  const now = deps.now();
  const today = utcDay(now);
  const weekStart = utcDay(new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000));

  const autonomy = deps.loadProfile(repoPath).then(
    (profile) => ({ configured: profile?.autonomy ?? null, error: null }),
    (err: unknown) => ({ configured: null, error: message(err) }),
  );

  const openUsd = open.reduce((sum, v) => sum + v.costUsd, 0);
  const spend = deps.historyRows(repoPath).then(
    (rows) => ({
      todayUsd: rows
        .filter((r) => r.date === today)
        .reduce((sum, r) => sum + r.cost_usd, 0),
      weekUsd: rows
        .filter((r) => r.date >= weekStart && r.date <= today)
        .reduce((sum, r) => sum + r.cost_usd, 0),
      openUsd,
      error: null,
    }),
    (err: unknown) => ({
      todayUsd: 0,
      weekUsd: 0,
      openUsd,
      error: message(err),
    }),
  );

  // The gaps the router hit on the open tasks' routes, each named once.
  const gaps = [
    ...new Set(
      open.flatMap((v) =>
        v.assemblyText === undefined
          ? []
          : (parseAssembly(v.assemblyText).assembly?.gaps ?? []),
      ),
    ),
  ];
  const skills = Promise.all([
    deps.readLock(repoPath),
    deps.readState(repoPath),
    deps.skillsStatus(repoPath),
  ]).then(
    ([lock, state, problems]) => ({
      locked: lock.skills.length,
      installed: state?.skills.filter((s) => s.installed).length ?? 0,
      problems,
      gaps,
      error: null,
    }),
    (err: unknown) => ({
      locked: 0,
      installed: 0,
      problems: [],
      gaps,
      error: message(err),
    }),
  );

  return {
    repoPath,
    autonomy: await autonomy,
    spend: await spend,
    skills: await skills,
  };
}

/** A check run, as much of one as the summary reads. */
export interface CheckRun {
  status: string;
  conclusion: string | null;
  head_sha: string;
}

export interface CiClient {
  defaultBranch(owner: string, repo: string): Promise<string>;
  checkRuns(owner: string, repo: string, ref: string): Promise<CheckRun[]>;
}

export interface CiDeps {
  resolveRepoSlug: typeof resolveRepoSlug;
  githubToken: typeof githubToken;
  client: (token: string) => CiClient;
}

/** A read that takes longer than this is given up, so the strip says so. */
const CI_TIMEOUT_MS = 10_000;

const octokitClient = (token: string): CiClient => {
  const octokit = new Octokit({ auth: token, log: QUIET_LOG });
  const request = () => ({ signal: AbortSignal.timeout(CI_TIMEOUT_MS) });
  return {
    async defaultBranch(owner, repo) {
      const { data } = await octokit.rest.repos.get({
        owner,
        repo,
        request: request(),
      });
      return data.default_branch;
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

const ciDeps: CiDeps = {
  resolveRepoSlug,
  githubToken,
  client: octokitClient,
};

const FAILED = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
]);

/** The check runs on the default branch's head, said in one line. */
export function ciSummary(
  runs: CheckRun[],
  branch: string,
  url: string,
): NowCi {
  const at = runs[0] ? ` at ${runs[0].head_sha.slice(0, 7)}` : "";
  if (runs.length === 0)
    return {
      state: "none",
      branch,
      url,
      detail: `no checks ran on ${branch}'s latest commit`,
    };
  const failed = runs.filter(
    (r) => r.status === "completed" && FAILED.has(r.conclusion ?? ""),
  ).length;
  const pending = runs.filter((r) => r.status !== "completed").length;
  if (failed > 0)
    return {
      state: "failing",
      branch,
      url,
      detail: `${failed} of ${runs.length} checks failed on ${branch}${at}`,
    };
  if (pending > 0)
    return {
      state: "running",
      branch,
      url,
      detail: `${pending} of ${runs.length} checks still running on ${branch}${at}`,
    };
  return {
    state: "passing",
    branch,
    url,
    detail: `${runs.length} ${runs.length === 1 ? "check" : "checks"} passed on ${branch}${at}`,
  };
}

/**
 * main's CI, only for a person signed in to GitHub in the app: their token
 * goes through `githubToken()` as the explicit one. Signed out, or with no
 * GitHub origin, it says so instead of reaching for another token.
 */
export async function mainCi(
  repoPath: string,
  signedInToken: string | null,
  deps: CiDeps = ciDeps,
): Promise<NowCi> {
  const none = (state: NowCi["state"], detail: string): NowCi => ({
    state,
    branch: null,
    url: null,
    detail,
  });
  if (!signedInToken) return none("signed-out", "sign in to see CI");
  const slug = await deps.resolveRepoSlug(repoPath);
  if (!slug)
    return none(
      "unavailable",
      "this repo has no GitHub origin to read CI from",
    );
  const token = await deps.githubToken(repoPath, signedInToken);
  if (!token) return none("signed-out", "sign in to see CI");
  try {
    const client = deps.client(token.token);
    const branch = await client.defaultBranch(slug.owner, slug.repo);
    const runs = await client.checkRuns(slug.owner, slug.repo, branch);
    return ciSummary(
      runs,
      branch,
      `https://github.com/${slug.owner}/${slug.repo}/commits/${encodeURIComponent(branch)}`,
    );
  } catch (err) {
    return none("unavailable", `CI couldn't be read: ${message(err)}`);
  }
}
