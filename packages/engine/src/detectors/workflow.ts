import type { DetectorConfig } from "@arynbht/rivetari-catalog";
import { parse as parseYaml } from "yaml";

import type { AuditContext, GitHubClient } from "../context.js";
import type { DetectorResult } from "./types.js";
import { splitGlobs } from "./util.js";

type WorkflowConfig = Extract<DetectorConfig, { type: "workflow" }>;
export type WorkflowCheck = WorkflowConfig["check"];

export const WORKFLOW_FILES =
  ".github/workflows/*.yml|.github/workflows/*.yaml";

export type Job = Record<string, unknown>;

/** A parsed workflow file: `doc` is the plain object, never null. */
export interface Workflow {
  path: string;
  doc: Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A workflow file that couldn't be read as a workflow, and why. */
export interface Unreadable {
  path: string;
  reason: string;
}

export interface LoadedWorkflows {
  workflows: Workflow[];
  unreadable: Unreadable[];
}

/** The workflows under `.github/workflows`, minus `exclude`, and the files that don't parse. */
export async function loadWorkflows(
  ctx: AuditContext,
  exclude?: string,
): Promise<LoadedWorkflows> {
  let files = await ctx.glob(splitGlobs(WORKFLOW_FILES));
  if (exclude) {
    const excluded = new Set(await ctx.glob(splitGlobs(exclude)));
    files = files.filter((f) => !excluded.has(f));
  }
  const workflows: Workflow[] = [];
  const unreadable: Unreadable[] = [];
  for (const path of files.sort()) {
    const text = await ctx.readFile(path);
    if (text === null) continue;
    try {
      const doc: unknown = parseYaml(text);
      if (isRecord(doc)) workflows.push({ path, doc });
      else unreadable.push({ path, reason: "not a YAML mapping" });
    } catch (err) {
      unreadable.push({
        path,
        reason: (err as Error).message.split("\n")[0] ?? "",
      });
    }
  }
  return { workflows, unreadable };
}

/** "couldn't parse a.yml: reason; b.yml: reason". */
export function unreadableMessage(unreadable: Unreadable[]): string {
  return `couldn't parse ${unreadable.map((u) => `${u.path}: ${u.reason}`).join("; ")}`;
}

/** The events a workflow runs on, from any of `on`'s three shapes. */
export function triggers(workflow: Workflow): string[] {
  // YAML 1.1 readers turn a bare `on` key into `true`; the `yaml` package doesn't.
  const on = workflow.doc.on ?? workflow.doc.true;
  if (typeof on === "string") return [on];
  if (Array.isArray(on)) return on.map(String);
  if (isRecord(on)) return Object.keys(on);
  return [];
}

export function runsOnPr(workflow: Workflow): boolean {
  return triggers(workflow).includes("pull_request");
}

export function jobsOf(workflow: Workflow): [string, Job][] {
  const jobs = workflow.doc.jobs;
  if (!isRecord(jobs)) return [];
  return Object.entries(jobs).filter((entry): entry is [string, Job] =>
    isRecord(entry[1]),
  );
}

export function stepsOf(job: Job): Record<string, unknown>[] {
  return Array.isArray(job.steps) ? job.steps.filter(isRecord) : [];
}

export function needsOf(job: Job): string[] {
  if (typeof job.needs === "string") return [job.needs];
  return Array.isArray(job.needs) ? job.needs.map(String) : [];
}

function ifOf(job: Job): string {
  return typeof job.if === "string" ? job.if : "";
}

/** A job whose `if` keeps it off pull requests. */
export function skipsPr(job: Job): boolean {
  return /!=\s*['"]pull_request['"]/.test(ifOf(job));
}

/** The job GitHub reports as `ci`: keyed `ci`, or named `ci`. */
export function ciJob(workflow: Workflow): [string, Job] | undefined {
  const jobs = jobsOf(workflow);
  return (
    jobs.find(([key]) => key === "ci") ??
    jobs.find(([, job]) => job.name === "ci")
  );
}

/** The jobs that `key` depends on, directly or not. */
function upstreamOf(workflow: Workflow, key: string): Set<string> {
  const jobs = new Map(jobsOf(workflow));
  const seen = new Set<string>();
  const queue = needsOf(jobs.get(key) ?? {});
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...needsOf(jobs.get(next) ?? {}));
  }
  return seen;
}

/**
 * The PR jobs an aggregator keyed `key` has to wait for: every other job that
 * runs on pull requests and doesn't itself wait for the aggregator.
 */
export function aggregatedJobs(workflow: Workflow, key: string): string[] {
  return jobsOf(workflow)
    .filter(([other, job]) => other !== key && !skipsPr(job))
    .filter(([other]) => !upstreamOf(workflow, other).has(key))
    .map(([other]) => other);
}

/** Why `ci` isn't an aggregator, or null when it is (or is the only job). */
export function aggregatorGap(workflow: Workflow): string | null {
  const found = ciJob(workflow);
  if (!found) return "has no `ci` job";
  const [key, job] = found;
  const wanted = aggregatedJobs(workflow, key);
  if (wanted.length === 0) return null;
  if (!ifOf(job).includes("always()")) {
    return "has a `ci` job that doesn't run with `if: always()`, so a failed job skips it";
  }
  // A job can be left out on purpose (an e2e run only some changes need), so
  // the aggregator has to wait for some jobs, not all of them.
  if (upstreamOf(workflow, key).size === 0) {
    return "has a `ci` job that waits for no other job";
  }
  // With `always()` the job runs after a failure too, so it has to read the
  // results and fail on one itself.
  return stepsOf(job).some((step) => READS_RESULTS.test(JSON.stringify(step)))
    ? null
    : "has a `ci` job that never reads its needs' results, so it passes when they fail";
}

const READS_RESULTS = /needs\.(\*|[\w-]+)\.result/;
const CANCEL_ON_PR = /github\.event_name\s*==\s*['"]pull_request['"]/;
// PR runs share a group per PR, so a push supersedes the last; every other run
// gets its own commit's or run's group, so none is ever replaced.
const GROUP_PER_RUN =
  /github\.event_name\s*==\s*['"]pull_request['"]\s*&&\s*(github\.ref|github\.head_ref|github\.event\.pull_request\.number)\s*\|\|\s*github\.(sha|run_id)/;

/** Why a PR workflow's concurrency is wrong, or null when it's right. */
export function concurrencyGap(workflow: Workflow): string | null {
  const concurrency = workflow.doc.concurrency;
  if (!isRecord(concurrency)) {
    return "doesn't cancel superseded pull request runs";
  }
  const cancel = concurrency["cancel-in-progress"];
  // A manual run shares no group with a pull request's, so it doesn't count.
  const prOnly = triggers(workflow)
    .filter((t) => t !== "workflow_dispatch")
    .every((t) => t.startsWith("pull_request"));
  if (prOnly) {
    return cancel === true ||
      (typeof cancel === "string" && CANCEL_ON_PR.test(cancel))
      ? null
      : "doesn't cancel superseded pull request runs";
  }
  if (cancel === true) {
    return "cancels in-progress runs on every event, the default branch's too";
  }
  if (typeof cancel !== "string" || !CANCEL_ON_PR.test(cancel)) {
    return "doesn't cancel superseded pull request runs, and only those";
  }
  const group = concurrency.group;
  return typeof group === "string" && GROUP_PER_RUN.test(group)
    ? null
    : "doesn't group PR runs by PR and other runs by commit, so a superseded PR run is kept or a merge's pending run is replaced";
}

/** The jobs in a workflow that run with no `timeout-minutes`. */
export function jobsWithoutTimeout(workflow: Workflow): string[] {
  return (
    jobsOf(workflow)
      // A job that calls a reusable workflow can't set a timeout itself.
      .filter(([, job]) => job.uses === undefined)
      .filter(([, job]) => job["timeout-minutes"] === undefined)
      .map(([key]) => key)
  );
}

const PATH_FILTER_ACTION = /^(dorny\/paths-filter|tj-actions\/changed-files)@/;

export function filtersPaths(workflow: Workflow): boolean {
  const on = workflow.doc.on ?? workflow.doc.true;
  const pr = isRecord(on) ? on.pull_request : undefined;
  if (
    isRecord(pr) &&
    (pr.paths !== undefined || pr["paths-ignore"] !== undefined)
  ) {
    return true;
  }
  return jobsOf(workflow).some(([, job]) =>
    stepsOf(job).some(
      (step) =>
        typeof step.uses === "string" && PATH_FILTER_ACTION.test(step.uses),
    ),
  );
}

/**
 * A GitHub-hosted Windows or macOS label (`windows-latest`, `macos-14`). A bare
 * `windows` or `macOS` label is a self-hosted runner, whose minutes are free.
 */
export const PAID_OS = /^(windows|macos)-/i;

function osValues(job: Job): unknown[] {
  const values: unknown[] = [];
  const runsOn = job["runs-on"];
  if (Array.isArray(runsOn)) values.push(...runsOn);
  else values.push(runsOn);
  const strategy = isRecord(job.strategy) ? job.strategy : {};
  const matrix = isRecord(strategy.matrix) ? strategy.matrix : {};
  if (Array.isArray(matrix.os)) values.push(...matrix.os);
  if (Array.isArray(matrix.include)) {
    for (const entry of matrix.include) {
      if (isRecord(entry)) values.push(entry.os, entry["runs-on"]);
    }
  }
  return values;
}

/** PR jobs that run on Windows or macOS runners. */
export function paidOsJobs(workflow: Workflow): string[] {
  if (!runsOnPr(workflow)) return [];
  return jobsOf(workflow)
    .filter(([, job]) => !skipsPr(job))
    .filter(([, job]) => !osValues(job).includes("self-hosted"))
    .filter(([, job]) =>
      osValues(job).some(
        (v) => typeof v === "string" && PAID_OS.test(v) && !v.includes("${{"),
      ),
    )
    .map(([key]) => key);
}

const SECRET_SCAN_ACTION =
  /^(gitleaks\/gitleaks-action|trufflesecurity\/trufflehog)@/i;
const SECRET_SCAN_RUN = /\b(gitleaks|trufflehog|ggshield)\b/i;

export function scansSecrets(job: Job): boolean {
  return stepsOf(job).some(
    (step) =>
      (typeof step.uses === "string" && SECRET_SCAN_ACTION.test(step.uses)) ||
      (typeof step.run === "string" && SECRET_SCAN_RUN.test(step.run)),
  );
}

export function scansSecretsOnPr(workflow: Workflow): boolean {
  if (!runsOnPr(workflow)) return false;
  return jobsOf(workflow).some(([, job]) => !skipsPr(job) && scansSecrets(job));
}

interface RepoVisibility {
  private: boolean;
}

/** Whether the repo is private, shared with the github-api detector's cache. */
export async function isPrivateRepo(gh: GitHubClient): Promise<boolean> {
  const repo = await gh.cached("repos.get", async () => {
    const { data } = await gh.octokit.rest.repos.get({
      owner: gh.owner,
      repo: gh.repo,
    });
    return data as RepoVisibility;
  });
  return repo.private;
}

const pass = (message: string): DetectorResult => ({ status: "pass", message });
const fail = (message: string): DetectorResult => ({ status: "fail", message });

function listed(gaps: string[]): string {
  return gaps.join("; ");
}

type CheckFn = (
  workflows: Workflow[],
  ctx: AuditContext,
) => Promise<DetectorResult>;

const checks: Record<WorkflowCheck, CheckFn> = {
  "required-aggregator": async (workflows) => {
    const pr = workflows.filter(runsOnPr);
    if (pr.length === 0) return fail("no workflow runs on pull_request");
    const gaps: string[] = [];
    for (const workflow of pr) {
      const gap = aggregatorGap(workflow);
      if (gap === null) {
        return pass(
          `${workflow.path}: the \`ci\` job gates the pull request jobs it needs`,
        );
      }
      gaps.push(`${workflow.path} ${gap}`);
    }
    return fail(listed(gaps));
  },

  "concurrency-pr-only": async (workflows) => {
    const pr = workflows.filter(runsOnPr);
    if (pr.length === 0) return fail("no workflow runs on pull_request");
    const gaps = pr.flatMap((workflow) => {
      const gap = concurrencyGap(workflow);
      return gap ? [`${workflow.path} ${gap}`] : [];
    });
    return gaps.length > 0
      ? fail(listed(gaps))
      : pass(
          "superseded pull request runs are cancelled; other runs never are",
        );
  },

  "job-timeouts": async (workflows) => {
    if (workflows.length === 0) return fail("no GitHub Actions workflows");
    const gaps = workflows.flatMap((workflow) => {
      const jobs = jobsWithoutTimeout(workflow);
      return jobs.length > 0 ? [`${workflow.path}: ${jobs.join(", ")}`] : [];
    });
    return gaps.length > 0
      ? fail(`jobs with no timeout-minutes: ${listed(gaps)}`)
      : pass("every job sets timeout-minutes");
  },

  "docs-path-filter": async (workflows) => {
    const pr = workflows.filter(runsOnPr);
    if (pr.length === 0) return fail("no workflow runs on pull_request");
    const filtered = pr.find(filtersPaths);
    return filtered
      ? pass(`${filtered.path} filters pull requests by the paths they change`)
      : fail(
          "no pull request workflow filters by path, so docs-only changes run every job",
        );
  },

  "pr-os-matrix": async (workflows, ctx) => {
    const gh = await ctx.github();
    if (!gh) {
      return {
        status: "skip",
        message: "needs a GitHub token to read the repo's visibility",
      };
    }
    let isPrivate: boolean;
    try {
      isPrivate = await isPrivateRepo(gh);
    } catch (err) {
      return {
        status: "skip",
        message: `couldn't read the repo: ${(err as Error).message}`,
      };
    }
    if (!isPrivate) return pass("public repo: every runner OS is free");
    const gaps = workflows.flatMap((workflow) => {
      const jobs = paidOsJobs(workflow);
      return jobs.length > 0 ? [`${workflow.path}: ${jobs.join(", ")}`] : [];
    });
    return gaps.length > 0
      ? fail(`Windows or macOS runs on every pull request: ${listed(gaps)}`)
      : pass("pull requests run on Linux only");
  },

  "secret-scan-on-pr": async (workflows) => {
    const found = workflows.find(scansSecretsOnPr);
    return found
      ? pass(`${found.path} scans pull request commits for secrets`)
      : fail("no pull request workflow scans the PR's commits for secrets");
  },
};

/** Structural checks on the repo's GitHub Actions workflows. */
export async function workflow(
  ctx: AuditContext,
  config: WorkflowConfig,
): Promise<DetectorResult> {
  const { workflows, unreadable } = await loadWorkflows(ctx, config.exclude);
  // A file the check can't read could hold exactly what it looks for, so it
  // fails rather than passing on the rest.
  if (unreadable.length > 0) return fail(unreadableMessage(unreadable));
  return checks[config.check](workflows, ctx);
}
