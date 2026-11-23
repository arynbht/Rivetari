import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

import { type Control, loadBundledCatalog } from "@arynbht/rivetari-catalog";
import {
  allowlistedEnv,
  buildContext,
  type CommandListener,
  type ControlResult,
  deepEqual,
  detectStacks,
  evaluateControls,
  runTool,
  splitArgs,
  templateStacks,
  ToolNotFoundError,
} from "@arynbht/rivetari-engine";
import { type SimpleGit, simpleGit } from "simple-git";

import type { Card } from "../task/card.js";
import { bannedCheck, loadBanned } from "./banned.js";
import { diffRules, type Hunk } from "./diff-rules.js";
import {
  acquireWorkspace,
  dependencyKey,
  installedKey,
  type CheckScope,
  readBaseResults,
  setInstalledKey,
  workspaceScope,
  writeBaseResults,
} from "./workspace.js";
import {
  type DiffEntry,
  findProtected,
  isProtectedConfig,
  isTestFile,
  parseNameStatus,
  type ProtectedFinding,
} from "./protected.js";
import { generatedPaths } from "./tier2.js";

export { parseNameStatus } from "./protected.js";
export { type CheckOutcome, outcomeOf, type Side } from "./outcome.js";
import { type CheckOutcome, compare, side } from "./outcome.js";

export interface Tier1Result {
  verdict: "pass" | "fail" | "needs-human";
  base: string;
  head: string;
  mergeBase: string;
  changedFiles: number;
  protected: ProtectedFinding[];
  checks: CheckOutcome[];
  /** Why the verdict is `fail` when no individual check explains it. */
  notes: string[];
  workDir: string;
  /** The test suite's run on the change, in full: the test-run proof. */
  testRun?: { command: string; exitCode: number; output: string } | undefined;
}

export interface Tier1Options {
  /** The repo holding both commits (the primary checkout). */
  repoPath: string;
  /** The base ref the change targets, e.g. `origin/main`. */
  base: string;
  /** The change under review (default `HEAD`). */
  head?: string | undefined;
  /** Control ids to run (default: every `quality` control that applies). */
  checks?: readonly string[] | undefined;
  /** Where to clone (default: a fresh temp dir, removed unless `keep`). */
  workDir?: string | undefined;
  keep?: boolean | undefined;
  /**
   * Variables passed to installs and checks on top of the allowlist (system
   * paths, home/temp dirs, toolchain homes). Nothing else from the caller's
   * shell reaches the repo's scripts: no tokens, no API keys.
   */
  env?: readonly string[] | undefined;
  /**
   * Protected changes a person already allowed (at build). They don't make
   * the verdict `needs-human`, and the checks run on them as changed: the
   * rest of the protected paths are still put back to base.
   */
  allowed?: ((finding: ProtectedFinding) => boolean) | undefined;
  card?: Card | undefined;
  noNewComments?: boolean | undefined;
  generatedGlobs?: readonly string[] | undefined;
  /** Install dependencies in the clone before checking (default true). */
  install?: boolean | undefined;
  /**
   * Judge in the repo's persistent workspace, installing only when the
   * dependencies changed (ignored with `workDir`).
   */
  persistent?: boolean | undefined;
  /** Where persistent workspaces live (default: the user's cache). */
  workspaceRoot?: string | undefined;
  now?: Date | undefined;
  /** Progress lines, e.g. to stderr. */
  log?: ((line: string) => void) | undefined;
}

const LOCKFILES = [
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "npm-shrinkwrap.json",
];
const INSTALL_TIMEOUT_MS = 15 * 60_000;
const CLONE_PREFIX = "rivetari-judge-";
const STALE_MS = 24 * 60 * 60_000;

/** Remove judge clones a crashed run left behind (older than 24 hours). */
export async function sweepStaleClones(
  root: string = tmpdir(),
  now: number = Date.now(),
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(CLONE_PREFIX)) continue;
    const path = join(root, name);
    try {
      if (now - (await stat(path)).mtimeMs > STALE_MS) {
        await rm(path, { recursive: true, force: true });
      }
    } catch {
      // Another run may be removing it; not our problem.
    }
  }
}

/**
 * Judge tier 1: deterministic checks on a clean clone, never the agent's
 * worktree.
 *
 *  1. Diff `merge-base(base, head)..head` and look for protected changes
 *     (`.rivetari/**`, lint/CI config, package.json scripts, existing tests,
 *     added suppressions). Any → `needs-human`.
 *  2. Clone the repo, check out the merge-base, install, run the checks: the
 *     baseline.
 *  3. Check out `head`, put every protected path back as it was at base (so the
 *     change is judged by the rules it was written against, not rules it
 *     edited), install if dependencies changed, and run the checks again.
 *  4. Fail closed: a check that can't run (missing script, missing tool,
 *     timeout) is red. Red on both sides is pre-existing; red only on the
 *     change is a failure.
 */
export async function runTier1(options: Tier1Options): Promise<Tier1Result> {
  const log = options.log ?? (() => undefined);
  const repo = simpleGit(options.repoPath);
  const base = (await repo.revparse([options.base])).trim();
  const head = (await repo.revparse([options.head ?? "HEAD"])).trim();
  const mergeBase = (await repo.raw(["merge-base", base, head])).trim();

  const diff = parseNameStatus(
    await repo.raw(["diff", "--name-status", "-M", mergeBase, head]),
  );
  const unified = await repo.raw([
    "diff",
    "-U0",
    "--no-color",
    mergeBase,
    head,
  ]);
  const added = parseAddedLines(unified);
  const baseScripts = await scriptsAt(repo, mergeBase);
  const headScripts = await scriptsAt(repo, head);
  const scriptsChanged = !deepEqual(baseScripts, headScripts);
  const generated = await generatedPaths(repo, [...added.keys()]);
  const protectedFindings = findProtected(
    diff,
    added,
    scriptsChanged,
    generated,
  );
  // A person approved these: judge them as the change has them. Put back to
  // base, an approved test change would fail against the code it was changed
  // for, every round.
  const allowedFindings = protectedFindings.filter(
    (f) => options.allowed?.(f) ?? false,
  );
  const keep = new Set(allowedFindings.map((f) => f.path));
  const keepScripts = allowedFindings.some((f) => f.reason === "scripts");

  // The repo's persistent workspace when asked for and free; otherwise a
  // unique directory per run (two judges on one task never collide). Both sit
  // outside the repo, so they never show up in `git status` or its audits.
  await sweepStaleClones();
  const workspace =
    options.persistent && !options.workDir
      ? await acquireWorkspace(options.repoPath, {
          root: options.workspaceRoot,
        })
      : null;
  const workDir =
    workspace?.dir ??
    options.workDir ??
    (await mkdtemp(join(tmpdir(), CLONE_PREFIX)));
  const notes: string[] = [];
  try {
    if (!workspace) {
      log(`cloning into ${workDir}`);
      await simpleGit().clone(options.repoPath, workDir, [
        "--quiet",
        "--shared",
        "--no-checkout",
      ]);
    } else
      log(
        `${workspace.created ? "cloning into" : "reusing"} the judge workspace ${workDir}`,
      );
    // simple-git guards core.hooksPath against hook injection; here it points
    // at an empty directory we just made, which is the opposite of injection.
    const clone = simpleGit(workDir, {
      unsafe: { allowUnsafeHooksPath: true },
    });
    // The target repo's hooks never run inside the judge.
    const noHooks = join(workDir, ".git", "rivetari-no-hooks");
    await mkdir(noHooks, { recursive: true });
    await clone.addConfig("core.hooksPath", noHooks);

    // Baseline. A reused workspace keeps only its installed dependencies:
    // everything else a past round left, ignored or not, goes.
    await clone.raw(["checkout", "--quiet", "--force", "--detach", mergeBase]);
    if (workspace) await clone.raw(["clean", "-fdxq", "-e", "node_modules"]);
    const install = options.install ?? true;
    const key = workspace && install ? await dependencyKey(workDir) : null;
    const reuse = key !== null && (await installedKey(workDir)) === key;
    if (reuse)
      log("dependencies unchanged since the last install: reusing them");
    if (workspace && !reuse) await setInstalledKey(workDir, null);
    const baseInstall =
      install && !reuse ? await installDeps(workDir, log, options.env) : null;
    if (key !== null && !reuse && baseInstall?.ok !== false)
      await setInstalledKey(workDir, key);
    // In a pnpm workspace, only the packages the change can affect are
    // checked, on both sides, so the comparison stays like for like.
    const scoped = scopeChecks(
      await selectChecks(options),
      await workspaceScope(
        repo,
        [mergeBase, head],
        diff.flatMap((e) => (e.oldPath ? [e.path, e.oldPath] : [e.path])),
      ),
      baseScripts,
    );
    const selected = scoped.controls;
    notes.push(...scoped.notes);
    for (const note of scoped.notes) log(note);
    // The base's results depend only on the base commit, the checks (scoped
    // ones carry their packages), the installed dependencies and the env the
    // checks see, so every round and task on the same base shares one run.
    const baseKey = options.persistent
      ? createHash("sha256")
          .update(
            JSON.stringify({
              mergeBase,
              checks: selected,
              deps: install
                ? (key ?? (await dependencyKey(workDir)))
                : "not installed",
              env: options.env ?? [],
            }),
          )
          .digest("hex")
      : null;
    const cached = baseKey
      ? await readBaseResults(options.repoPath, baseKey, options.workspaceRoot)
      : null;
    const kept = new Map((cached ?? []).map((r) => [r.controlId, r]));
    // Coverage is read from the same side's test run, so it can't run alone.
    const rerun = selected.filter(
      (c) =>
        !kept.has(c.id) ||
        (runsTests(c) &&
          selected.some((s) => s.id === COVERAGE && !kept.has(s.id))),
    );
    const reused = selected.filter((c) => !rerun.includes(c));
    if (reused.length > 0)
      log(
        `checks at base ${mergeBase.slice(0, 12)} already ran green: reusing ${reused.map((c) => c.id).join(", ")}`,
      );
    let baseResults = reused.flatMap((c) => kept.get(c.id) ?? []);
    if (rerun.length > 0) {
      log("running checks at base");
      baseResults = [
        ...baseResults,
        ...(await runChecks(workDir, rerun, options)),
      ];
      if (baseKey && (baseInstall?.ok ?? true))
        await writeBaseResults(
          options.repoPath,
          baseKey,
          baseResults,
          options.workspaceRoot,
        );
    }

    // The change, judged by the base's rules. The base's checks may have
    // written into tracked or untracked files (a build into a committed dist);
    // the clone is ours, so throw that away rather than refuse to switch.
    await clone.raw(["checkout", "--quiet", "--force", "--detach", head]);
    await clone.raw(["clean", "-fdq"]);
    await restoreProtected(
      clone,
      workDir,
      diff.filter((e) => !keep.has(e.path)),
      mergeBase,
    );
    if (scriptsChanged && !keepScripts)
      await restoreScripts(workDir, baseScripts);
    const depsChanged = diff.some(
      (e) =>
        e.path === "package.json" ||
        e.path.endsWith("/package.json") ||
        LOCKFILES.includes(e.path),
    );
    // The change's own dependencies replace the base's in the workspace, so
    // the next round can't take them for the base's.
    if (workspace && install && depsChanged)
      await setInstalledKey(workDir, null);
    const headInstall =
      install && depsChanged
        ? await installDeps(workDir, log, options.env)
        : baseInstall;
    log("running checks on the change");
    let testRun: Tier1Result["testRun"];
    const keepLog: CommandListener = (line, result) => {
      testRun = {
        command: line,
        exitCode: result.exitCode,
        output: `${result.stdout}\n${result.stderr}`,
      };
    };
    let headResults = await runChecks(workDir, selected, options, keepLog);

    // Tests green at base but red on the change get one more run, as the
    // proof used to give them: a pass on the retry is a flake, not the change.
    const tests = selected.find(runsTests);
    const sideOf = (results: ControlResult[]) =>
      side(results.find((r) => r.controlId === tests?.id));
    const failing =
      testRun && testRun.exitCode !== 0 ? failingTestFiles(testRun.output) : [];
    const beyond =
      failing.length > 0 && testRun ? failureBeyondFiles(testRun.output) : [];
    if (
      tests &&
      beyond.length > 0 &&
      sideOf(baseResults) === "green" &&
      sideOf(headResults) === "red"
    ) {
      log(
        `tests failed on the change and the run also reported ${beyond.join(", ")}: not re-running alone`,
      );
      notes.push(
        `${failing.join(", ")} failed in the full run, which also reported ${beyond.join(", ")}: the named files don't account for every failure, so none were re-run alone`,
      );
    } else if (
      tests &&
      testRun &&
      failing.length > 0 &&
      sideOf(baseResults) === "green" &&
      sideOf(headResults) === "red"
    ) {
      log(
        `tests failed on the change but pass at base: re-running ${failing.join(", ")} alone`,
      );
      const command = testRun.command;
      const alone = await rerunAlone(workDir, command, failing, tests, {
        env: options.env,
        log,
      });
      const stillFailing = alone.filter((r) => !r.passed);
      if (stillFailing.length === 0) {
        headResults = headResults.map((r) =>
          r.controlId === tests.id ? passedAlone(r, command, failing) : r,
        );
        for (const file of failing)
          notes.push(
            `${file} failed in the full run but passed alone: flaky under load, not blamed on this change`,
          );
      } else {
        testRun = {
          ...testRun,
          output: [
            testRun.output,
            ...stillFailing.map((r) => `\n${r.command} (alone)\n${r.output}`),
          ].join("\n"),
        };
        notes.push(
          `${stillFailing.map((r) => r.file).join(", ")} failed in the full run and again alone`,
        );
      }
    } else if (
      tests &&
      sideOf(baseResults) === "green" &&
      sideOf(headResults) === "red"
    ) {
      log(
        "tests failed on the change but pass at base: running them once more",
      );
      const again = selected.filter((c) => runsTests(c) || c.id === COVERAGE);
      const retry = await runChecks(workDir, again, options, keepLog);
      if (sideOf(retry) === "green") {
        headResults = [
          ...headResults.filter(
            (r) => !again.some((c) => c.id === r.controlId),
          ),
          ...retry,
        ];
        notes.push(
          "tests failed on the change, then passed on one retry: flaky, not blamed on this change",
        );
      }
    }

    if (headInstall && !headInstall.ok) {
      notes.push(`dependency install failed: ${headInstall.message}`);
    }

    // A check the scope left out is shown as not run, never dropped silently.
    const catalogChecks = [
      ...compare(baseResults, headResults),
      ...scoped.skipped.map((c): CheckOutcome => ({
        id: c.id,
        title: c.title,
        base: "n/a",
        head: "n/a",
        outcome: "n/a",
        message: COVERAGE_SKIPPED,
      })),
    ];
    const checks = [
      ...catalogChecks,
      bannedCheck(await loadBanned(options.repoPath, mergeBase), added),
      ...diffRules(diff, added, {
        card: options.card,
        noNewComments: options.noNewComments,
        generatedGlobs: options.generatedGlobs,
        hunks: parseHunks(unified),
        allowedSuppressions: new Set(
          allowedFindings
            .filter((f) => f.reason === "suppression")
            .map((f) => f.path),
        ),
        generated,
      }),
    ];
    const ran = catalogChecks.filter((c) => c.outcome !== "n/a");
    if (ran.length === 0) {
      notes.push(
        "no check applies to this repo (unknown stack?); nothing was verified",
      );
    }

    // The judge installs only Node dependencies so far. For other stacks, a
    // check that's red on both sides may just be a dependency the clone lacks,
    // so "pre-existing" can't be trusted there: fail and say why, never pass.
    const unverifiable = templateStacks(
      await detectStacks(buildContext(workDir)),
    ).filter((s) => s !== "node");
    const preExisting = checks.some((c) => c.outcome === "pre-existing");
    if (unverifiable.length > 0 && preExisting) {
      notes.push(
        `${unverifiable.join("/")} dependencies aren't installed by the judge yet; a check that's red at base may be a missing dependency, so the judge can't verify this change`,
      );
    }

    const failed =
      ran.length === 0 ||
      (unverifiable.length > 0 && preExisting) ||
      checks.some((c) => c.outcome === "fail") ||
      (headInstall !== null && !headInstall.ok && !(baseInstall?.ok === false));

    return {
      verdict:
        protectedFindings.length > allowedFindings.length
          ? "needs-human"
          : failed
            ? "fail"
            : "pass",
      base,
      head,
      mergeBase,
      changedFiles: diff.length,
      protected: protectedFindings,
      checks,
      notes,
      workDir,
      testRun,
    };
  } finally {
    if (workspace) await workspace.release();
    else if (!options.keep && !options.workDir) {
      await rm(workDir, { recursive: true, force: true }).catch(
        () => undefined,
      );
    }
  }
}

/**
 * The checks a change is judged on by default: the quality lane's code checks.
 * Repository settings (github-api) are posture, judged by `rivetari audit`, not
 * by a change.
 */
export async function changeChecks(): Promise<Control[]> {
  const { controls } = await loadBundledCatalog();
  return controls.filter(
    (c) =>
      c.lane === "quality" && !c.detect.some((d) => d.type === "github-api"),
  );
}

async function selectChecks(options: Tier1Options): Promise<Control[]> {
  return options.checks
    ? (await loadBundledCatalog()).controls.filter((c) =>
        options.checks?.includes(c.id),
      )
    : changeChecks();
}

/**
 * The checks narrowed to a workspace scope, with notes saying what was checked
 * and why. A check is narrowed only when its root script's runner takes the
 * packages as a filter of what it would run anyway; any other runs in full. A
 * narrowed test run covers part of the code, so the coverage floor, which
 * holds the whole repo, runs only when the tests run in full.
 */
export function scopeChecks(
  selected: readonly Control[],
  scope: CheckScope | null,
  scripts: Record<string, unknown>,
): { controls: Control[]; notes: string[]; skipped: Control[] } {
  if (!scope) return { controls: [...selected], notes: [], skipped: [] };
  if (scope.kind === "all")
    return {
      controls: [...selected],
      notes: [`checked every workspace package: ${scope.why}`],
      skipped: [],
    };
  const narrowed = new Map<string, string>();
  const full: string[] = [];
  for (const control of selected) {
    const line = nodeLine(control);
    const name = line ? npmScript(line) : null;
    if (!line || !name) continue;
    const script = scripts[name];
    const scopedLine =
      typeof script === "string"
        ? narrowScript(line, script, scope.dirs, scope.filters)
        : null;
    if (scopedLine) narrowed.set(control.id, scopedLine);
    else full.push(control.id);
  }
  if (narrowed.size === 0)
    return {
      controls: [...selected],
      notes: [
        `checked every workspace package: the change touches ${scope.dirs.join(", ")} only, but no check's script can be narrowed to packages`,
      ],
      skipped: [],
    };
  const testsNarrowed = selected.some(
    (c) => runsTests(c) && narrowed.has(c.id),
  );
  const skipped = selected.filter((c) => testsNarrowed && c.id === COVERAGE);
  const controls = selected
    .filter((c) => !skipped.includes(c))
    .map((c) => {
      const scopedLine = narrowed.get(c.id);
      return scopedLine ? withNodeLine(c, scopedLine) : c;
    });
  const notes = [
    `checked ${scope.dirs.join(", ")} only: the change touches ${scope.touched.join(", ")}${scope.dependents.length > 0 ? `, and ${scope.dependents.join(", ")} depend${scope.dependents.length === 1 ? "s" : ""} on it` : ""}`,
  ];
  if (full.length > 0)
    notes.push(
      `${full.join(", ")} ran on every package: ${full.length === 1 ? "its script" : "their scripts"} can't be narrowed to packages`,
    );
  if (skipped.length > 0) notes.push(`${COVERAGE} ${COVERAGE_SKIPPED}`);
  return { controls, notes, skipped };
}

const COVERAGE_SKIPPED =
  "not checked: the tests ran for the affected packages only, and part of the suite can't be held to the whole repo's floor; it runs with the full suite";

function nodeLine(control: Control): string | undefined {
  for (const d of control.detect)
    if (d.type === "command" && d.byStack?.node) return d.byStack.node;
  return undefined;
}

function withNodeLine(control: Control, line: string): Control {
  return {
    ...control,
    detect: control.detect.map((d) =>
      d.type === "command" && d.byStack?.node
        ? { ...d, byStack: { ...d.byStack, node: line } }
        : d,
    ),
  };
}

/** The root script an `npm test` or `npm run <name>` line runs. */
function npmScript(line: string): string | null {
  const match = /^npm\s+(?:(test|start)|run(?:-script)?\s+(\S+))$/.exec(
    line.trim(),
  );
  return match ? (match[1] ?? match[2] ?? null) : null;
}

/**
 * The command that runs `line`'s script for `dirs` alone, or null when its
 * runner can't be told which packages to run. Two shapes narrow: a script whose
 * last step is vitest or jest (the packages become path filters, coverage off),
 * and `pnpm -r run <script>` (the packages become filters).
 */
export function narrowScript(
  line: string,
  script: string,
  dirs: readonly string[],
  filters: readonly string[] = dirs.map((d) => `./${d}`),
): string | null {
  // Commands are split on whitespace, so a directory with a space can't pass.
  if (dirs.length === 0 || [...dirs, ...filters].some((d) => /\s/.test(d)))
    return null;
  const text = script.trim();
  const recursive =
    /^pnpm\s+(?:-r|--recursive)\s+(?:run\s+([\w:.-]+)|(test))$/.exec(text);
  if (recursive) {
    const name = recursive[1] ?? recursive[2] ?? "";
    return `pnpm ${filters.map((f) => `--filter=${f}`).join(" ")} run --if-present ${name}`;
  }
  // Only plain `a && b` chains: anything else may not pass the args to the end.
  if (/[|;<>`&]|\$\(/.test(text.replace(/&&/g, " "))) return null;
  const last = text.split("&&").at(-1)?.trim() ?? "";
  const runner = /^(?:(?:npx|pnpm\s+exec|pnpm)\s+)?(vitest|jest)(?:\s|$)/.exec(
    last,
  )?.[1];
  if (!runner || /--watch\b/.test(last)) return null;
  const coverageOff =
    runner === "vitest" ? "--coverage.enabled=false" : "--coverage=false";
  return `${line.trim()} -- ${dirs.map((d) => `${d}/`).join(" ")} --passWithNoTests ${coverageOff}`;
}

async function runChecks(
  dir: string,
  selected: readonly Control[],
  options: Tier1Options,
  onTests?: CommandListener,
): Promise<ControlResult[]> {
  // One at a time, test runs first: coverage is read from what *this* side's
  // test run wrote, so the previous side's report is removed before it starts.
  await rm(join(dir, "coverage"), { recursive: true, force: true });
  const context = (onCommand?: CommandListener) =>
    buildContext(dir, {
      runCommands: true,
      commandEnv: allowlistedEnv(options.env),
      now: options.now,
      onCommand,
    });
  const profile = await context()
    .profile()
    .catch(() => null);
  // Waivers are posture decisions; the judge holds every check to its result.
  const evaluate = (controls: Control[], ctx = context()) =>
    evaluateControls(controls, ctx, {
      profile,
      waivers: [],
      now: options.now,
      concurrency: 1,
    });
  return [
    ...(await evaluate(selected.filter(runsTests), context(onTests))),
    ...(await evaluate(selected.filter((c) => !runsTests(c)))),
  ];
}

function runsTests(control: Control): boolean {
  return control.id === "quality.tests.pass";
}

export function failingTestFiles(output: string): string[] {
  const files: string[] = [];
  for (const line of stripVTControlCharacters(output).split(/\r?\n/)) {
    const file = /^\s*FAIL\s+(\S+\.[cm]?[jt]sx?)(?=\s|$)/.exec(line)?.[1];
    if (file && !files.includes(file)) files.push(file);
  }
  return files;
}

const BEYOND_FILES: readonly (readonly [RegExp, string])[] = [
  [/\bUnhandled (?:Errors?|Rejections?)\b/, "unhandled errors"],
  [/^\s*Errors\s+\d+\s+errors?\b/m, "unhandled errors"],
  [/\bType Errors?\b/, "type errors"],
  [/\bdoes not meet (?:global )?threshold/i, "a coverage threshold miss"],
];

export function failureBeyondFiles(output: string): string[] {
  const text = stripVTControlCharacters(output);
  const found: string[] = [];
  for (const [pattern, reason] of BEYOND_FILES)
    if (pattern.test(text) && !found.includes(reason)) found.push(reason);
  return found;
}

interface AloneRun {
  file: string;
  command: string;
  passed: boolean;
  output: string;
}

async function rerunAlone(
  dir: string,
  line: string,
  files: readonly string[],
  tests: Control,
  options: {
    env?: readonly string[] | undefined;
    log: (line: string) => void;
  },
): Promise<AloneRun[]> {
  const detector = tests.detect.find((d) => d.type === "command");
  const timeout = detector?.type === "command" ? detector.timeout : undefined;
  const [binary, ...all] = splitArgs(line);
  // A scoped run already passes its packages after `--`; the file alone is
  // narrower than they are, so it replaces them.
  const cut = all.indexOf("--");
  const args = cut === -1 ? all : all.slice(0, cut);
  const runs: AloneRun[] = [];
  for (const file of files) {
    const argv = [...args, "--", file, "--coverage.enabled=false"];
    const command = [binary, ...argv].join(" ");
    options.log(`running ${file} alone: ${command}`);
    try {
      if (!binary) throw new Error(`no command to run ${file} with`);
      const result = await runTool(binary, argv, dir, {
        timeoutMs: (timeout ?? 60) * 1000,
        env: allowlistedEnv(options.env),
      });
      runs.push({
        file,
        command,
        passed: result.exitCode === 0,
        output: `${result.stdout}\n${result.stderr}`,
      });
    } catch (err) {
      runs.push({
        file,
        command,
        passed: false,
        output: `could not run ${file} alone: ${(err as Error).message}`,
      });
    }
  }
  return runs;
}

function passedAlone(
  result: ControlResult,
  command: string,
  files: readonly string[],
): ControlResult {
  return {
    ...result,
    status: "pass",
    detectors: [
      {
        status: "pass",
        message: `\`${command}\` failed under load; ${files.join(", ")} passed alone`,
      },
    ],
  };
}

const COVERAGE = "quality.coverage.floor";

/** Put protected paths back to their base state in the clone. */
async function restoreProtected(
  clone: SimpleGit,
  dir: string,
  diff: readonly DiffEntry[],
  mergeBase: string,
): Promise<void> {
  for (const entry of diff) {
    const config =
      isProtectedConfig(entry.path) ||
      (entry.oldPath !== undefined && isProtectedConfig(entry.oldPath));
    const existingTest =
      entry.status !== "A" &&
      (isTestFile(entry.path) ||
        (entry.oldPath !== undefined && isTestFile(entry.oldPath)));
    if (!config && !existingTest) continue;

    // Whatever the change put at the new path goes...
    if (entry.status !== "D") {
      await rm(join(dir, entry.path), { force: true });
    }
    // ...and whatever base had comes back.
    const basePath =
      entry.status === "R"
        ? entry.oldPath
        : entry.status === "A"
          ? undefined
          : entry.path;
    if (basePath) {
      await clone.raw(["checkout", "--quiet", mergeBase, "--", basePath]);
    }
  }
}

async function restoreScripts(
  dir: string,
  baseScripts: Record<string, unknown>,
): Promise<void> {
  const path = join(dir, "package.json");
  const pkg = JSON.parse(await readFile(path, "utf8")) as Record<
    string,
    unknown
  >;
  pkg["scripts"] = baseScripts;
  await writeFile(path, `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

async function scriptsAt(
  repo: SimpleGit,
  rev: string,
): Promise<Record<string, unknown>> {
  try {
    const text = await repo.show([`${rev}:package.json`]);
    const pkg = JSON.parse(text) as { scripts?: Record<string, unknown> };
    return pkg.scripts ?? {};
  } catch {
    return {};
  }
}

async function exists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false);
}

/** Install Node dependencies with the repo's package manager, from its lockfile. */
async function installDeps(
  dir: string,
  log: (line: string) => void,
  env: readonly string[] | undefined,
): Promise<{ ok: boolean; message: string } | null> {
  const pkgPath = join(dir, "package.json");
  if (!(await exists(pkgPath))) return null;
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
    dependencies?: object;
    devDependencies?: object;
  };
  const deps =
    Object.keys(pkg.dependencies ?? {}).length +
    Object.keys(pkg.devDependencies ?? {}).length;
  if (deps === 0) return null;

  let cmd: [string, string[]];
  if (await exists(join(dir, "pnpm-lock.yaml"))) {
    cmd = ["pnpm", ["install", "--frozen-lockfile"]];
  } else if (await exists(join(dir, "yarn.lock"))) {
    cmd = ["yarn", ["install", "--frozen-lockfile"]];
  } else if (await exists(join(dir, "package-lock.json"))) {
    cmd = ["npm", ["ci", "--no-audit", "--no-fund"]];
  } else {
    cmd = ["npm", ["install", "--no-audit", "--no-fund"]];
  }
  log(`installing dependencies: ${cmd[0]} ${cmd[1].join(" ")}`);
  try {
    const result = await runTool(cmd[0], cmd[1], dir, {
      timeoutMs: INSTALL_TIMEOUT_MS,
      env: allowlistedEnv(env),
    });
    return result.exitCode === 0
      ? { ok: true, message: "installed" }
      : {
          ok: false,
          message: `${cmd[0]} exited ${result.exitCode}: ${result.stderr.trim().split("\n").slice(-3).join(" ")}`,
        };
  } catch (err) {
    return {
      ok: false,
      message:
        err instanceof ToolNotFoundError
          ? `${cmd[0]} is not installed`
          : (err as Error).message,
    };
  }
}

export function parseAddedLines(output: string): Map<string, string[]> {
  const added = new Map<string, string[]>();
  let current: string | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      current = target === "/dev/null" ? null : target.replace(/^b\//, "");
      continue;
    }
    if (current && line.startsWith("+") && !line.startsWith("+++")) {
      const lines = added.get(current) ?? [];
      lines.push(line.slice(1));
      added.set(current, lines);
    }
  }
  return added;
}

/** Each file's hunks from a `git diff -U0`, with the lines each one swaps. */
export function parseHunks(output: string): Map<string, Hunk[]> {
  const hunks = new Map<string, Hunk[]>();
  let current: Hunk[] | null = null;
  let header = false;
  for (const line of output.split("\n")) {
    if (line.startsWith("diff --git ")) {
      current = null;
      header = true;
      continue;
    }
    if (header && line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      current = null;
      if (target !== "/dev/null") {
        const path = target.replace(/^b\//, "");
        current = hunks.get(path) ?? [];
        hunks.set(path, current);
      }
      continue;
    }
    if (line.startsWith("@@")) {
      header = false;
      current?.push({ removed: [], added: [] });
      continue;
    }
    const hunk = header ? undefined : current?.at(-1);
    if (!hunk) continue;
    if (line.startsWith("+")) hunk.added.push(line.slice(1));
    else if (line.startsWith("-")) hunk.removed.push(line.slice(1));
  }
  return hunks;
}
