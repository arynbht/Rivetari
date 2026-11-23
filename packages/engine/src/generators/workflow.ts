import type { Control } from "@arynbht/rivetari-catalog";
import { Octokit } from "@octokit/rest";
import {
  type Document,
  isMap,
  isScalar,
  isSeq,
  Pair,
  parseDocument,
  Scalar,
  type YAMLMap,
} from "yaml";

import { type AuditContext, QUIET_LOG } from "../context.js";
import {
  aggregatedJobs,
  aggregatorGap,
  ciJob,
  concurrencyGap,
  filtersPaths,
  isPrivateRepo,
  isRecord,
  type Job,
  jobsOf,
  jobsWithoutTimeout,
  loadWorkflows,
  needsOf,
  paidOsJobs,
  runsOnPr,
  scansSecrets,
  scansSecretsOnPr,
  type Workflow,
} from "../detectors/workflow.js";
import type { Change, Generator } from "./types.js";

type Patch = Extract<Control["fix"], { type: "workflow" }>["patch"];

/** Rivetari's own workflow is left alone, as the workflow controls skip it. */
const DEFAULT_EXCLUDE =
  ".github/workflows/rivetari.yml|.github/workflows/rivetari.yaml";

/** A cap well above a normal build, so only a hung job ever reaches it. */
export const DEFAULT_TIMEOUT_MINUTES = 30;

const CHECKOUT = "actions/checkout@11d5960a326750d5838078e36cf38b85af677262";
const CHECKOUT_TAG = "v4.4.0";
const PATHS_FILTER =
  "dorny/paths-filter@ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d";
const PATHS_FILTER_TAG = "v4.0.3";
const TRUFFLEHOG =
  "trufflesecurity/trufflehog@ea68ca03c865c5f324e86e849ced20ed3cf9dbbb";
const TRUFFLEHOG_TAG = "v3.99.8";

const CONCURRENCY = {
  // Main runs are grouped by commit, so a merge never replaces the run before it.
  group:
    "${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
  "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
};

const RESULTS_STEP = {
  name: "Fail if a needed job failed",
  env: { RESULTS: "${{ join(needs.*.result, ' ') }}" },
  run: [
    "for r in $RESULTS; do",
    '  if [ "$r" != "success" ] && [ "$r" != "skipped" ]; then',
    `    echo "::error::a required job finished with '$r'"`,
    "    exit 1",
    "  fi",
    "done",
    "",
  ].join("\n"),
};

const CODE_CHANGED = "needs.changes.outputs.code == 'true'";
const NOT_PR = "github.event_name != 'pull_request'";

function keyOf(pair: Pair): unknown {
  return isScalar(pair.key) ? pair.key.value : pair.key;
}

function jobsMap(doc: Document): YAMLMap | null {
  const jobs = doc.get("jobs", true);
  return isMap(jobs) ? jobs : null;
}

function jobMap(doc: Document, key: string): YAMLMap | null {
  const job = jobsMap(doc)?.get(key, true);
  return isMap(job) ? job : null;
}

/** Set `key` in `map`, placed after the first of `after` present (else at the end). */
function setAfter(
  doc: Document,
  map: YAMLMap,
  key: string,
  value: unknown,
  after: string[],
): void {
  if (map.has(key)) {
    map.set(key, doc.createNode(value));
    return;
  }
  const pair = new Pair(doc.createNode(key), doc.createNode(value));
  const anchor = after
    .map((a) => map.items.findIndex((p) => keyOf(p) === a))
    .find((i) => i >= 0);
  if (anchor === undefined) map.items.push(pair);
  else map.items.splice(anchor + 1, 0, pair);
}

/** Set `key` in `map`, placed before the first of `before` present (else at the end). */
function setBefore(
  doc: Document,
  map: YAMLMap,
  key: string,
  value: unknown,
  before: string[],
): void {
  if (map.has(key)) {
    map.set(key, doc.createNode(value));
    return;
  }
  const pair = new Pair(doc.createNode(key), doc.createNode(value));
  const indexes = map.items
    .map((p, i) => (before.includes(String(keyOf(p))) ? i : -1))
    .filter((i) => i >= 0);
  if (indexes.length === 0) map.items.push(pair);
  else map.items.splice(Math.min(...indexes), 0, pair);
}

// A job reads name, needs, if, then how it runs.
const JOB_BODY = [
  "runs-on",
  "environment",
  "strategy",
  "timeout-minutes",
  "steps",
  "uses",
];

function setNeeds(doc: Document, job: YAMLMap, needs: string[]): void {
  setBefore(doc, job, "needs", needs, ["if", ...JOB_BODY]);
}

function setIf(doc: Document, job: YAMLMap, condition: string): void {
  setBefore(doc, job, "if", condition, JOB_BODY);
}

/** A pinned `uses:` with its tag as the trailing comment, as in Rivetari's templates. */
function pinned(doc: Document, ref: string, tag: string): Scalar {
  const node = doc.createNode(ref) as Scalar;
  node.comment = ` ${tag}`;
  return node;
}

function bare(condition: string): string {
  const match = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(condition);
  return (match?.[1] ?? condition).trim();
}

/** `existing && condition`, or just `condition` when the job has no `if`. */
export function combineIf(existing: unknown, condition: string): string {
  if (typeof existing !== "string" || existing.trim() === "") return condition;
  return `(${bare(existing)}) && ${condition}`;
}

function addNeed(doc: Document, job: YAMLMap, plain: Job, need: string): void {
  const needs = needsOf(plain);
  if (needs.includes(need)) return;
  setNeeds(doc, job, [...needs, need]);
}

/** The aggregator: the `ci` job that runs after the others whatever they did. */
function aggregatorKey(workflow: Workflow): string | undefined {
  const found = ciJob(workflow);
  if (!found) return undefined;
  const [key, job] = found;
  return typeof job.if === "string" && job.if.includes("always()")
    ? key
    : undefined;
}

/** The workflow a new job belongs in: the one with `ci`, else `ci.yml`, else the first PR workflow. */
function targetWorkflow(workflows: Workflow[]): Workflow | undefined {
  const pr = workflows.filter(runsOnPr);
  return (
    pr.find((w) => ciJob(w)) ??
    pr.find((w) => /\/ci\.ya?ml$/.test(w.path)) ??
    pr[0]
  );
}

type Edit = (doc: Document, workflow: Workflow) => boolean;

interface Planned {
  path: string;
  edit: Edit;
}

type PatchFn = (
  ctx: AuditContext,
  workflows: Workflow[],
) => Promise<Planned[] | string>;

const NO_PR_WORKFLOW =
  "no workflow runs on pull_request; add one first (`ci.workflow.present`)";

function onTarget(workflows: Workflow[], edit: Edit): Planned[] | string {
  const target = targetWorkflow(workflows);
  return target ? [{ path: target.path, edit }] : NO_PR_WORKFLOW;
}

const addAggregator: Edit = (doc, workflow) => {
  const jobs = jobsMap(doc);
  if (!jobs || aggregatorGap(workflow) === null) return false;
  const found = ciJob(workflow);
  if (!found) {
    const needs = aggregatedJobs(workflow, "ci");
    if (needs.length === 0) return false;
    jobs.set(
      "ci",
      doc.createNode({
        name: "ci",
        if: "always()",
        needs,
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        steps: [RESULTS_STEP],
      }),
    );
    return true;
  }
  const [key, plain] = found;
  const job = jobMap(doc, key);
  const steps = job?.get("steps", true);
  if (!job || !isSeq(steps)) return false;
  const needs = [
    ...new Set([...needsOf(plain), ...aggregatedJobs(workflow, key)]),
  ];
  setNeeds(doc, job, needs);
  if (typeof plain.if !== "string" || !plain.if.includes("always()")) {
    // `always()` alone would let the job pass over a failed need, so the
    // results check goes first.
    const condition =
      typeof plain.if === "string" && plain.if.trim() !== ""
        ? `always() && (${bare(plain.if)})`
        : "always()";
    setIf(doc, job, condition);
  }
  const hasCheck = steps.items.some(
    (s) => isMap(s) && s.get("name") === RESULTS_STEP.name,
  );
  if (!hasCheck) steps.items.unshift(doc.createNode(RESULTS_STEP));
  return true;
};

const setConcurrency: Edit = (doc, workflow) => {
  if (concurrencyGap(workflow) === null) return false;
  const root = doc.contents;
  if (!isMap(root)) return false;
  setBefore(doc, root, "concurrency", CONCURRENCY, ["jobs"]);
  return true;
};

const addTimeouts: Edit = (doc, workflow) => {
  const missing = jobsWithoutTimeout(workflow);
  for (const key of missing) {
    const job = jobMap(doc, key);
    if (job) {
      setAfter(doc, job, "timeout-minutes", DEFAULT_TIMEOUT_MINUTES, [
        "runs-on",
      ]);
    }
  }
  return missing.length > 0;
};

const addPathFilter: Edit = (doc, workflow) => {
  const jobs = jobsMap(doc);
  if (!jobs || filtersPaths(workflow) || jobs.has("changes")) return false;
  const aggregator = aggregatorKey(workflow);
  const filterStep = doc.createNode({
    name: "Filter paths",
    id: "filter",
    // Pull requests read their files from the API, so no checkout; every other
    // event runs everything.
    if: "github.event_name == 'pull_request'",
    uses: PATHS_FILTER,
    with: {
      "predicate-quantifier": "every",
      filters: [
        "code:",
        '  - "**"',
        '  - "!docs/**"',
        '  - "!**/*.md"',
        "",
      ].join("\n"),
    },
  }) as YAMLMap;
  filterStep.set("uses", pinned(doc, PATHS_FILTER, PATHS_FILTER_TAG));
  const changes = doc.createNode({
    name: "changes",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 5,
    permissions: { contents: "read", "pull-requests": "read" },
    outputs: {
      code: "${{ github.event_name != 'pull_request' || steps.filter.outputs.code == 'true' }}",
    },
    steps: [],
  }) as YAMLMap;
  const steps = changes.get("steps", true);
  if (isSeq(steps)) steps.items.push(filterStep);
  jobs.items.unshift(new Pair(doc.createNode("changes"), changes));

  for (const [key, plain] of jobsOf(workflow)) {
    const job = jobMap(doc, key);
    if (!job) continue;
    addNeed(doc, job, plain, "changes");
    // The aggregator and the secret scan run on every change, docs included.
    if (key === aggregator || scansSecrets(plain)) continue;
    setIf(doc, job, combineIf(plain.if, CODE_CHANGED));
  }
  return true;
};

const PAID_OS = /\b(windows|macos)\b/i;

const keepPaidOsOffPrs: Edit = (doc, workflow) => {
  const offending = paidOsJobs(workflow);
  const jobs = new Map(jobsOf(workflow));
  for (const key of offending) {
    const plain = jobs.get(key) ?? {};
    const job = jobMap(doc, key);
    if (!job) continue;
    const strategy = isRecord(plain.strategy) ? plain.strategy : {};
    const matrix = isRecord(strategy.matrix) ? strategy.matrix : {};
    const os = Array.isArray(matrix.os) ? matrix.os.map(String) : null;
    const free = os?.filter((v) => !PAID_OS.test(v)) ?? [];
    const runsOnMatrix =
      typeof plain["runs-on"] === "string" &&
      plain["runs-on"].includes("matrix.os");
    if (os && free.length > 0 && runsOnMatrix && matrix.include === undefined) {
      // Pull requests keep the free runners; every other event runs them all.
      doc.setIn(
        ["jobs", key, "strategy", "matrix", "os"],
        `\${{ github.event_name == 'pull_request' && fromJSON('${JSON.stringify(free)}') || fromJSON('${JSON.stringify(os)}') }}`,
      );
    } else {
      setIf(doc, job, combineIf(plain.if, NOT_PR));
    }
  }
  return offending.length > 0;
};

const addSecretScan: Edit = (doc, workflow) => {
  const jobs = jobsMap(doc);
  if (!jobs || workflow.doc.jobs === undefined) return false;
  const key = jobs.has("secret-scan") ? "secret-scan-pr" : "secret-scan";
  const checkout = doc.createNode({
    name: "Checkout",
    uses: CHECKOUT,
    // The scan reads the PR's commits, so their history has to be present.
    with: { "fetch-depth": 0 },
  }) as YAMLMap;
  checkout.set("uses", pinned(doc, CHECKOUT, CHECKOUT_TAG));
  // TruffleHog needs no license on any account (gitleaks-action does on an
  // organization's), and on a pull request it scans base..head by itself.
  const scan = doc.createNode({
    name: "TruffleHog",
    uses: TRUFFLEHOG,
    with: { extra_args: "--results=verified,unknown" },
  }) as YAMLMap;
  scan.set("uses", pinned(doc, TRUFFLEHOG, TRUFFLEHOG_TAG));
  const job = doc.createNode({
    name: "secret-scan",
    "runs-on": "ubuntu-latest",
    "timeout-minutes": 10,
    permissions: { contents: "read" },
    steps: [],
  }) as YAMLMap;
  const steps = job.get("steps", true);
  if (isSeq(steps)) steps.items.push(checkout, scan);
  const aggregator = aggregatorKey(workflow);
  const index = jobs.items.findIndex((p) => keyOf(p) === aggregator);
  const pair = new Pair(doc.createNode(key), job);
  if (index < 0) jobs.items.push(pair);
  else jobs.items.splice(index, 0, pair);
  const aggregatorJob = aggregator ? jobMap(doc, aggregator) : null;
  if (aggregator && aggregatorJob) {
    const plain = new Map(jobsOf(workflow)).get(aggregator) ?? {};
    addNeed(doc, aggregatorJob, plain, key);
  }
  return true;
};

/** `owner/repo[/path]@ref` actions not yet pinned to a full commit sha. */
const PINNED = /^(\.\/|docker:\/\/|[^@\s]+@[0-9a-f]{40}$)/;

export type ShaResolver = (
  owner: string,
  repo: string,
  ref: string,
) => Promise<string | null>;

/**
 * Pin every `uses:` in the document to the commit its tag points at, keeping the
 * tag as a comment. Returns the references that couldn't be resolved.
 */
export async function pinActions(
  doc: Document,
  resolve: ShaResolver,
): Promise<{ changed: boolean; unresolved: string[] }> {
  const jobs = jobsMap(doc);
  const nodes: Scalar[] = [];
  for (const pair of jobs?.items ?? []) {
    if (!isMap(pair.value)) continue;
    const uses = pair.value.get("uses", true);
    if (isScalar(uses)) nodes.push(uses);
    const steps = pair.value.get("steps", true);
    if (!isSeq(steps)) continue;
    for (const step of steps.items) {
      const node = isMap(step) ? step.get("uses", true) : undefined;
      if (isScalar(node)) nodes.push(node);
    }
  }
  let changed = false;
  const unresolved: string[] = [];
  for (const node of nodes) {
    const value = String(node.value);
    if (PINNED.test(value)) continue;
    const match = /^([^/@\s]+)\/([^/@\s]+)((?:\/[^@\s]*)?)@(\S+)$/.exec(value);
    const sha = match
      ? await resolve(
          match[1] as string,
          match[2] as string,
          match[4] as string,
        )
      : null;
    if (!match || !sha) {
      unresolved.push(value);
      continue;
    }
    node.value = `${match[1]}/${match[2]}${match[3]}@${sha}`;
    node.comment = ` ${match[4]}`;
    changed = true;
  }
  return { changed, unresolved };
}

function githubResolver(octokit: Octokit): ShaResolver {
  const cache = new Map<string, Promise<string | null>>();
  return (owner, repo, ref) => {
    const key = `${owner}/${repo}@${ref}`;
    let found = cache.get(key);
    if (!found) {
      found = octokit.rest.repos
        .getCommit({ owner, repo, ref })
        .then(({ data }) => data.sha)
        .catch(() => null);
      cache.set(key, found);
    }
    return found;
  };
}

const patches: Record<Exclude<Patch, "pin-actions">, PatchFn> = {
  "required-aggregator": async (_ctx, workflows) =>
    onTarget(workflows, addAggregator),
  "concurrency-pr-only": async (_ctx, workflows) => {
    const pr = workflows.filter(runsOnPr);
    if (pr.length === 0) return NO_PR_WORKFLOW;
    return pr
      .filter((w) => concurrencyGap(w) !== null)
      .map((w) => ({ path: w.path, edit: setConcurrency }));
  },
  "job-timeouts": async (_ctx, workflows) =>
    workflows
      .filter((w) => jobsWithoutTimeout(w).length > 0)
      .map((w) => ({ path: w.path, edit: addTimeouts })),
  "docs-path-filter": async (_ctx, workflows) =>
    workflows.filter(runsOnPr).some(filtersPaths)
      ? []
      : onTarget(workflows, addPathFilter),
  "pr-os-matrix": async (ctx, workflows) => {
    const gh = await ctx.github();
    // Only a private repo pays for Windows and macOS minutes.
    if (!gh) return "needs a GitHub token to read whether the repo is private";
    let isPrivate: boolean;
    try {
      isPrivate = await isPrivateRepo(gh);
    } catch (err) {
      return `couldn't read whether the repo is private: ${(err as Error).message}`;
    }
    if (!isPrivate) return [];
    return workflows
      .filter((w) => paidOsJobs(w).length > 0)
      .map((w) => ({ path: w.path, edit: keepPaidOsOffPrs }));
  },
  "secret-scan-on-pr": async (_ctx, workflows) =>
    workflows.some(scansSecretsOnPr) ? [] : onTarget(workflows, addSecretScan),
};

function excludeOf(control: Control): string {
  for (const config of control.detect) {
    if ("exclude" in config && typeof config.exclude === "string") {
      return config.exclude;
    }
  }
  return DEFAULT_EXCLUDE;
}

async function readDoc(
  ctx: AuditContext,
  path: string,
): Promise<{ doc: Document; bom: boolean } | null> {
  const text = await ctx.readFile(path);
  if (text === null) return null;
  return {
    doc: parseDocument(text, { keepSourceTokens: true }),
    bom: text.charCodeAt(0) === 0xfeff,
  };
}

function merged(
  control: Control,
  path: string,
  doc: Document,
  bom: boolean,
): Change {
  // No folding: a `${{ }}` expression stays on the line it's written on.
  const body = doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
  return {
    type: "file",
    controlId: control.id,
    path,
    op: "merge",
    contents: bom ? `\uFEFF${body}` : body,
  };
}

/**
 * Generator for `fix: { type: workflow, patch }`: edits the repo's GitHub Actions
 * workflows in place, keeping their comments and layout, to the shape the
 * matching `workflow` check asks for.
 */
export const workflowGenerator: Generator = async (ctx, control) => {
  if (control.fix?.type !== "workflow") return [];
  const { patch } = control.fix;
  const workflows = await loadWorkflows(ctx, excludeOf(control));
  const note = (message: string): Change[] => [
    { type: "note", controlId: control.id, message },
  ];

  if (patch === "pin-actions") {
    const gh = await ctx.github();
    const resolve = githubResolver(
      gh?.octokit ?? new Octokit({ log: QUIET_LOG }),
    );
    const changes: Change[] = [];
    const unresolved: string[] = [];
    for (const workflow of workflows) {
      const read = await readDoc(ctx, workflow.path);
      if (!read) continue;
      const result = await pinActions(read.doc, resolve);
      unresolved.push(
        ...result.unresolved.map((u) => `${workflow.path}: ${u}`),
      );
      if (result.changed)
        changes.push(merged(control, workflow.path, read.doc, read.bom));
    }
    if (unresolved.length > 0) {
      changes.push(
        ...note(
          `couldn't find the commit for ${unresolved.join(", ")}; pin these by hand`,
        ),
      );
    }
    return changes;
  }

  const planned = await patches[patch](ctx, workflows);
  if (typeof planned === "string") return note(planned);
  const changes: Change[] = [];
  for (const { path, edit } of planned) {
    const workflow = workflows.find((w) => w.path === path);
    const read = await readDoc(ctx, path);
    if (!workflow || !read) continue;
    if (edit(read.doc, workflow)) {
      changes.push(merged(control, path, read.doc, read.bom));
    }
  }
  return changes;
};
