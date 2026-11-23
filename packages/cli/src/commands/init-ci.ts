// The CI workflow `rivetari init` writes into a Node repo that has none: the
// shape of Rivetari's own fast pipeline (ci-next.yml), cut down to a template.
// A PR gets one Linux job, `ci`, that is the required check: draft PRs and
// docs-only changes skip the work but still report, superseded runs are
// cancelled, and every job has a timeout. The default branch runs everything,
// and the other OSes run where the repo's Actions plan can pay for them.
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildContext,
  resolveRepoSlug,
  resolveTemplateVars,
  githubToken,
} from "@arynbht/rivetari-engine";

const CHECKOUT =
  "actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0";
const PNPM_SETUP =
  "pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4.3.0";
const SETUP_NODE =
  "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4.4.0";
const PATHS_FILTER =
  "dorny/paths-filter@ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d # v4.0.3";

/**
 * How much CI the repo's plan pays for. `cheap` is a private repo on the free
 * plan, or one whose plan can't be read: Linux on PRs and pushes, other OSes
 * nightly. `full` is a public repo or a paid plan: every OS on every push.
 */
export interface CiPlan {
  tier: "cheap" | "full";
  /** Why, for the workflow's header and init's output. */
  why: string;
}

/** What the template needs to know about the repo. */
export interface CiFacts {
  packageManager: "npm" | "pnpm" | "yarn";
  /** package.json's `packageManager` field, when it names a version. */
  declared?: string | undefined;
  scripts: Record<string, string>;
  defaultBranch: string;
  /** Lockfile present now (setup-node's cache needs one). */
  lockfile: boolean;
  /** A pnpm or package.json workspace. */
  workspace: boolean;
  /** `.nvmrc` or `.node-version`, when the repo pins Node. */
  nodeVersionFile?: string | undefined;
}

const LOCKFILE = {
  npm: "package-lock.json",
  pnpm: "pnpm-lock.yaml",
  yarn: "yarn.lock",
};

// npm init's placeholder test script fails on purpose; it isn't a test suite.
const isPlaceholderTest = (s: string) => /no test specified/.test(s);

/** The checks the repo's own scripts give, in the order they run. */
function checks(facts: CiFacts): { label: string; script: string }[] {
  const s = facts.scripts;
  const pick = (...names: string[]) => names.find((n) => s[n]?.trim());
  const out: { label: string; script: string }[] = [];
  const lint = pick("lint");
  if (lint) out.push({ label: "Lint", script: lint });
  const typecheck = pick("typecheck", "type-check", "tsc");
  if (typecheck) out.push({ label: "Typecheck", script: typecheck });
  const test = pick("test");
  if (test && !isPlaceholderTest(s[test]!))
    out.push({ label: "Test", script: test });
  // A build catches what the others don't (Next.js typechecks in its build).
  const build = pick("build");
  if (build) out.push({ label: "Build", script: build });
  return out;
}

function installCommand(facts: CiFacts): string {
  const lock = LOCKFILE[facts.packageManager];
  const berry =
    facts.packageManager === "yarn" && /^yarn@[2-9]/.test(facts.declared ?? "");
  const frozen = {
    npm: "npm ci",
    pnpm: "pnpm install --frozen-lockfile",
    yarn: berry ? "yarn install --immutable" : "yarn install --frozen-lockfile",
  }[facts.packageManager];
  return `if [ -f ${lock} ]; then ${frozen}; else ${facts.packageManager} install; fi`;
}

/** Whether a root script just runs `script` in every workspace package. */
function runsInEveryPackage(facts: CiFacts, script: string): boolean {
  const recursive = new RegExp(
    String.raw`^pnpm\s+(-r|--recursive)\s+(run\s+)?${script}\s*$`,
  );
  return (
    facts.packageManager === "pnpm" &&
    facts.workspace &&
    recursive.test(facts.scripts[script] ?? "")
  );
}

// On a PR, the workspace packages the change touches and their dependents,
// as a pnpm filter. A change outside every package (root config, the
// lockfile) leaves it empty, and an empty filter checks everything.
const AFFECTED_STEP = String.raw`      - name: Affected packages
        id: affected
        if: github.event_name == 'pull_request' && steps.scope.outputs.code == 'true'
        run: |
          root=$(pwd)
          pkgs=$(pnpm ls -r --depth -1 --parseable | { grep -vx "$root" || true; } | sed "s|^$root/||")
          all=false
          for f in $(git diff --name-only HEAD^1 HEAD); do
            # What the path filter calls docs doesn't widen the run either.
            case "$f" in docs/*|.changeset/*|*.md) continue ;; esac
            inside=false
            for p in $pkgs; do case "$f" in "$p"/*) inside=true ;; esac; done
            if [ "$inside" = false ]; then all=true; fi
          done
          if [ "$all" = false ]; then echo 'filter=--filter "...[HEAD^1]"' >> "$GITHUB_OUTPUT"; fi`;

/**
 * The command for one check. In a pnpm workspace whose root script just runs
 * the script in every package (`pnpm -r …`), a PR job runs it only in the
 * affected packages; anything else runs the root script on the whole repo,
 * which is what "affected" means there.
 */
function checkCommand(facts: CiFacts, script: string, pr: boolean): string {
  const pm = facts.packageManager;
  const whole = pm === "yarn" ? `yarn ${script}` : `${pm} run ${script}`;
  return pr && runsInEveryPackage(facts, script)
    ? `pnpm \${{ steps.affected.outputs.filter }} --if-present run ${script}`
    : whole;
}

/** The steps a job runs; the PR job's are guarded by the path filter. */
function steps(facts: CiFacts, pr: boolean): string {
  const ifLine = pr ? `        if: steps.scope.outputs.code == 'true'\n` : "";
  const out: string[] = [];
  if (facts.packageManager === "pnpm")
    out.push(
      `      - name: Set up pnpm\n${ifLine}        uses: ${PNPM_SETUP}${
        // action-setup reads the version from packageManager only when that
        // field pins pnpm; otherwise (no field, or one naming another manager)
        // it needs a version here.
        /^pnpm@\d/.test(facts.declared ?? "")
          ? ""
          : "\n        with:\n          version: 9"
      }`,
    );
  if (
    facts.packageManager === "yarn" &&
    /^yarn@[2-9]/.test(facts.declared ?? "")
  )
    out.push(
      `      - name: Enable corepack\n${ifLine}        run: corepack enable`,
    );
  const node = facts.nodeVersionFile
    ? `node-version-file: ${facts.nodeVersionFile}`
    : `node-version: "22"`;
  out.push(
    `      - name: Set up Node\n${ifLine}        uses: ${SETUP_NODE}\n        with:\n          ${node}${
      facts.lockfile ? `\n          cache: ${facts.packageManager}` : ""
    }`,
  );
  out.push(
    `      - name: Install\n${ifLine}        run: ${installCommand(facts)}`,
  );
  const all = checks(facts);
  if (pr && all.some((c) => runsInEveryPackage(facts, c.script)))
    out.push(AFFECTED_STEP);
  for (const { label, script } of all)
    out.push(
      `      - name: ${label}\n${ifLine}        run: ${checkCommand(facts, script, pr)}`,
    );
  return out.join("\n");
}

/** Whether `text` is a CI workflow init wrote (and so may replace). */
export const isInitCiWorkflow = (text: string): boolean =>
  text.startsWith("# Written by `rivetari init`");

/** `.github/workflows/ci.yml` for a Node repo. */
export function renderCiWorkflow(facts: CiFacts, plan: CiPlan): string {
  const others =
    plan.tier === "full"
      ? ["windows-latest", "macos-latest"]
      : ["windows-latest"];
  const othersWhen =
    plan.tier === "full"
      ? "github.event_name == 'push' || github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'"
      : "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'";
  return `# Written by \`rivetari init\` for ${plan.why}. ${
    plan.tier === "full"
      ? "Every OS runs on each push to the default branch."
      : "Other OSes run nightly, where their minutes cost the least."
  }
#
# A PR gets one Linux job, \`ci\`, the check to require in branch protection.
# Draft PRs and changes that only touch docs skip the work and still report,
# and a newer push cancels the run before it. The default branch runs
# everything, and a red nightly is the signal to look at the other OSes.
name: ci

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  push:
    branches: [${facts.defaultBranch}]
  schedule:
    - cron: "41 3 * * *" # nightly, 03:41 UTC
  workflow_dispatch:

permissions:
  contents: read

# Superseded PR runs are cancelled. Pushes are grouped by commit, so a merge
# never cancels the run of the one before it.
concurrency:
  group: \${{ github.workflow }}-\${{ github.event_name == 'pull_request' && github.ref || github.sha }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}

jobs:
  ci:
    name: ci
    if: github.event_name != 'pull_request' || !github.event.pull_request.draft
    runs-on: ubuntu-latest
    timeout-minutes: 15
    permissions:
      contents: read
      pull-requests: read # the path filter reads the PR's files
    steps:
      - name: Checkout
        uses: ${CHECKOUT}
        with:
          # HEAD^1 of the merge commit is the base, for the affected filter.
          fetch-depth: 2
          persist-credentials: false
      - name: Filter paths
        id: filter
        if: github.event_name == 'pull_request'
        uses: ${PATHS_FILTER}
        with:
          predicate-quantifier: every
          filters: |
            code:
              - "**"
              - "!docs/**"
              - "!.changeset/**"
              - "!*.md"
              - "!**/CHANGELOG.md"
      - name: Scope
        id: scope
        run: echo "code=\${{ github.event_name != 'pull_request' || steps.filter.outputs.code == 'true' }}" >> "$GITHUB_OUTPUT"
${steps(facts, true)}

  other-os:
    name: other-os (\${{ matrix.os }})
    if: ${othersWhen}
    runs-on: \${{ matrix.os }}
    timeout-minutes: 30
    strategy:
      fail-fast: false
      matrix:
        os: [${others.join(", ")}]
    defaults:
      run:
        shell: bash
    steps:
      - name: Checkout
        uses: ${CHECKOUT}
        with:
          persist-credentials: false
${steps(facts, false)}
`;
}

export interface DetectPlanOptions {
  token?: string | undefined;
  fetch?: typeof fetch;
}

const CHEAP_UNKNOWN: CiPlan = {
  tier: "cheap",
  why: "a repo whose visibility and plan couldn't be read, so as a private repo on the free plan",
};

/**
 * The repo's CI tier from the GitHub API: public repos and paid plans get
 * `full`, a private repo on the free plan `cheap`, and anything that can't be
 * read is treated as the cheap case.
 */
export async function detectCiPlan(
  slug: { owner: string; repo: string } | null,
  options: DetectPlanOptions = {},
): Promise<CiPlan> {
  if (!slug || !options.token) return CHEAP_UNKNOWN;
  const get = options.fetch ?? fetch;
  const api = async <T>(path: string): Promise<T | null> => {
    const res = await get(`https://api.github.com${path}`, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "rivetari-cli",
        authorization: `Bearer ${options.token}`,
      },
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    // A proxy's HTML page or a body that stalls past the timeout reads as nothing.
    return res?.ok ? ((await res.json().catch(() => null)) as T | null) : null;
  };
  const repo = await api<{
    private?: boolean;
    owner?: { type?: string; login?: string };
  }>(`/repos/${slug.owner}/${slug.repo}`);
  if (!repo || typeof repo.private !== "boolean") return CHEAP_UNKNOWN;
  if (!repo.private)
    return {
      tier: "full",
      why: "a public repo, where Actions minutes are free",
    };
  // The plan shows only to the account itself, or an org's owners.
  const account =
    repo.owner?.type === "Organization"
      ? await api<{ plan?: { name?: string } }>(`/orgs/${slug.owner}`)
      : await api<{ login?: string; plan?: { name?: string } }>("/user").then(
          (u) =>
            u?.login?.toLowerCase() === slug.owner.toLowerCase() ? u : null,
        );
  const plan = account?.plan?.name;
  if (!plan)
    return {
      tier: "cheap",
      why: "a private repo whose plan couldn't be read, so as one on the free plan",
    };
  return plan === "free"
    ? { tier: "cheap", why: "a private repo on the free plan" }
    : { tier: "full", why: `a private repo on the ${plan} plan` };
}

export interface WriteCiOptions {
  /** A GitHub token to read the plan with; null is offline. */
  token?: string | null | undefined;
  /** Find the plan (tests). Default: the GitHub API. */
  detectPlan?: (() => Promise<CiPlan>) | undefined;
  force?: boolean | undefined;
}

const CI_REL = ".github/workflows/ci.yml";

export interface CiOutcome {
  /** The ci.yml to write, or null for none. */
  text: string | null;
  /** A note for init's summary. */
  note: string | null;
}

/**
 * `.github/workflows/ci.yml` for a Node repo with no CI of its own; init
 * writes it. A repo with other workflows keeps them and gets none, and a
 * ci.yml an earlier init wrote is rewritten under --force.
 */
export async function planCi(
  root: string,
  options: WriteCiOptions = {},
): Promise<CiOutcome> {
  const none = (note: string | null = null): CiOutcome => ({
    text: null,
    note,
  });
  const pkgText = await readFile(join(root, "package.json"), "utf8").catch(
    () => null,
  );
  if (pkgText === null) return none();
  const dir = join(root, ".github", "workflows");
  const theirs = (await readdir(dir).catch(() => [] as string[])).filter(
    (f) => /\.ya?ml$/.test(f) && !/^rivetari(\.rivetari)?\.ya?ml$/.test(f),
  );
  const ours = await readFile(join(root, CI_REL), "utf8")
    .then((t) => isInitCiWorkflow(t))
    .catch(() => false);
  if (ours && !options.force) return none();
  if (theirs.length > 0 && !ours)
    return none(
      `the repo has CI of its own (${theirs.map((f) => `.github/workflows/${f}`).join(", ")}), so init wrote no ci.yml`,
    );

  let pkg: {
    packageManager?: unknown;
    scripts?: Record<string, unknown>;
    workspaces?: unknown;
  } = {};
  try {
    const parsed: unknown = JSON.parse(pkgText);
    if (parsed && typeof parsed === "object") pkg = parsed as typeof pkg;
  } catch {
    return none(`package.json doesn't parse, so init wrote no ${CI_REL}`);
  }
  const vars = await resolveTemplateVars(buildContext(root));
  const there = (rel: string) =>
    access(join(root, rel)).then(
      () => true,
      () => false,
    );
  const nodeVersionFile = (await there(".nvmrc"))
    ? ".nvmrc"
    : (await there(".node-version"))
      ? ".node-version"
      : undefined;
  const facts: CiFacts = {
    packageManager: vars.packageManager,
    declared:
      typeof pkg.packageManager === "string" ? pkg.packageManager : undefined,
    scripts: Object.fromEntries(
      Object.entries(pkg.scripts ?? {}).filter(
        (e): e is [string, string] => typeof e[1] === "string",
      ),
    ),
    defaultBranch: vars.defaultBranch,
    lockfile: await there(LOCKFILE[vars.packageManager]),
    workspace: Boolean(pkg.workspaces) || (await there("pnpm-workspace.yaml")),
    nodeVersionFile,
  };
  const plan = options.detectPlan
    ? await options.detectPlan().catch(() => CHEAP_UNKNOWN)
    : options.token === null
      ? CHEAP_UNKNOWN
      : await detectCiPlan(await resolveRepoSlug(root), {
          token:
            options.token ?? (await githubToken(root).catch(() => null))?.token,
        }).catch(() => CHEAP_UNKNOWN);
  const checked = checks(facts).map((c) => c.script);
  return {
    text: renderCiWorkflow(facts, plan),
    note: `wrote ${CI_REL} for ${plan.why}: ${
      checked.length > 0
        ? `PRs run ${checked.join(", ")} on Linux in one job, \`ci\`; make it the required check`
        : "the repo has no lint, typecheck, test or build script yet, so `ci` only installs"
    }`,
  };
}
