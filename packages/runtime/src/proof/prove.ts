// The prove beat: the proof the assembly names, produced by a tool,
// never described by the agent. UI: the base and the change served side by
// side, shot at three breakpoints, axe on the change, the images on the
// `evidence` branch. Everything else: the test run, with the new tests named.
// The result goes to the ledger and `.rivetari/tasks/<id>/proof/proof.json`.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allowlistedEnv,
  buildContext,
  githubToken,
  installDeps,
  Octokit,
  packageManager,
  QUIET_LOG,
  resolveRepoSlug,
  runTool,
} from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { parse } from "yaml";

import { isTestFile } from "../judge/protected.js";
import {
  outcomeOf,
  parseAddedLines,
  parseNameStatus,
  type Side,
} from "../judge/tier1.js";
import { loadIsolation, type Isolation } from "../agent/isolate.js";
import { AssemblySchema, type ProofType } from "../router/route.js";
import {
  loadTask,
  nextStep,
  type Task,
  TaskError,
  TASKS_DIR,
} from "../task/tasks.js";
import { AuthError, signIn } from "./auth.js";
import { type EvidenceClient, publishEvidence } from "./evidence.js";
import { startServer } from "./server.js";
import { type AxeViolation, shoot, type Shot } from "./shoot.js";

/** The "before" server runs this far above the task's own port. */
const BEFORE_PORT_OFFSET = 1000;

export interface ProofRecord {
  task: string;
  kind: ProofType;
  passed: boolean;
  /** What the ledger says, one line each. */
  lines: string[];
  shots?: (Shot & { side: "before" | "after"; url?: string })[];
  violations?: AxeViolation[];
  tests?: {
    exitCode: number;
    added: string[];
    output: string;
    outcome?: "pass" | "fail" | "pre-existing" | "flaky" | undefined;
  };
}

export type Publish = (
  files: readonly string[],
) => Promise<{ file: string; url: string }[] | null>;

export interface ProveOptions {
  by: string;
  now?: Date | undefined;
  /** Upload to the evidence branch; default: GitHub via the token and origin. */
  publish?: Publish | undefined;
  /**
   * A test-run proof is the judge's tier 1 run on the change, not a run of
   * its own: record that here, and the judge publishes its run as the proof.
   */
  deferTestRun?: boolean | undefined;
}

export const DEFERRED =
  "proof deferred · test-run: the judge's tier 1 run on the change is the proof";

/**
 * The test-run proof from the judge's tier 1 run on the change: the suite runs
 * once a round, in the judge's clean workspace, and its log is the evidence.
 */
export async function proofFromJudge(
  repoPath: string,
  task: Task,
  isolation: Isolation,
  run: {
    testRun?: { command: string; exitCode: number; output: string } | undefined;
    outcome: "pass" | "fail" | "pre-existing" | "fixed" | "n/a" | undefined;
  },
  options: ProveOptions,
): Promise<ProofRecord> {
  const id = task.card.id;
  const git = simpleGit(isolation.worktree);
  const added = newTestNames(
    parseNameStatus(
      await git.raw(["diff", "--name-status", "-M", isolation.base, "HEAD"]),
    ),
    parseAddedLines(
      await git.raw(["diff", "-U0", "--no-color", isolation.base, "HEAD"]),
    ),
  );
  const lines: string[] = [];
  const outcome = run.outcome === "fixed" ? "pass" : (run.outcome ?? "n/a");
  const passed = outcome === "pass" || outcome === "pre-existing";
  const verdict = {
    pass: "tests passed",
    fail: "tests failed",
    "pre-existing":
      "tests failed on the change and on the base: pre-existing, not blamed on this change",
    "n/a": "tests: the judge found no test suite to run (fails closed)",
  }[outcome];
  const ran = run.testRun;
  lines.push(
    `${verdict}${ran ? ` (${ran.command}, exit ${ran.exitCode}, in the judge's tier 1 run on the change)` : ""} · new tests: ${added.join("; ") || "none"}`,
  );
  if (ran) lines.push(`output: ${tail(ran.output)}`);
  const proofDir = join(repoPath, TASKS_DIR, id, "proof");
  await mkdir(proofDir, { recursive: true });
  if (ran) {
    const log = join(proofDir, "test-run.txt");
    await writeFile(
      log,
      `${ran.command} · exit ${ran.exitCode} · the judge's tier 1 run on the change\nnew tests:\n${added.map((a) => `  ${a}`).join("\n") || "  none"}\n\n${ran.output}`,
      "utf8",
    );
    let published: Awaited<ReturnType<Publish>> = null;
    let notPushed = "no GitHub token or origin remote";
    try {
      published = await (options.publish ?? githubPublisher(repoPath, id))([
        log,
      ]);
    } catch (err) {
      notPushed = `upload failed: ${tail((err as Error).message, 200)}`;
    }
    lines.push(
      published?.[0]
        ? `evidence: the judge's test run on the evidence branch: ${published[0].url}`
        : `evidence: the judge's test run in ${TASKS_DIR}/${id}/proof/test-run.txt (not pushed: ${notPushed})`,
    );
  }
  const record: ProofRecord = {
    task: id,
    kind: "test-run",
    passed,
    lines,
    ...(ran
      ? {
          tests: {
            exitCode: ran.exitCode,
            added,
            output: ran.output.slice(-4000),
            outcome: outcome === "n/a" ? "fail" : outcome,
          },
        }
      : {}),
  };
  await writeFile(
    join(proofDir, "proof.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  const by = `rivetari runtime (for ${options.by})`;
  for (const line of lines)
    await task.ledger.append({
      beat: "prove",
      section: "proof",
      text: line,
      by,
      at: options.now,
    });
  await task.ledger.append({
    beat: "prove",
    section: "timeline",
    text: `proof ${passed ? "passed" : "failed"} · test-run (the judge's tier 1 run)`,
    by,
    at: options.now,
  });
  return record;
}

const tail = (s: string, n = 400) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
};

/** A detached checkout of `base` with hooks off, for the "before" side. */
async function baseCheckout(repoPath: string, base: string): Promise<string> {
  const git = simpleGit(repoPath);
  const commonDir = (
    await git.raw(["rev-parse", "--path-format=absolute", "--git-common-dir"])
  ).trim();
  const noHooks = join(commonDir, "rivetari-no-hooks");
  await mkdir(noHooks, { recursive: true });
  const dir = await mkdtemp(join(tmpdir(), "rivetari-proof-base-"));
  await simpleGit(repoPath, {
    unsafe: { allowUnsafeHooksPath: true },
    config: [`core.hooksPath=${noHooks}`],
  }).raw(["worktree", "add", "--detach", dir, base]);
  return dir;
}

const TEST_NAME = /\b(?:it|test)(?:\.\w+)?\(\s*(["'`])(.+?)\1/;

/**
 * The tests a change adds, by name ("new tests named"): every `it(…)` or
 * `test(…)` on an added line of a test file, whether the file is new or
 * existed at base. A new test file with no name we can read is listed by path.
 */
export function newTestNames(
  files: readonly { status: string; path: string }[],
  addedLines: Map<string, string[]>,
): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (f.status === "D" || !isTestFile(f.path)) continue;
    const names = (addedLines.get(f.path) ?? [])
      .map((l) => TEST_NAME.exec(l)?.[2])
      .filter((n): n is string => n !== undefined);
    if (names.length > 0) out.push(...names.map((n) => `${f.path}: ${n}`));
    else if (f.status === "A") out.push(f.path);
  }
  return out;
}

const runTests = (pm: string, cwd: string) =>
  runTool(pm, ["run", "test"], cwd, {
    env: allowlistedEnv(),
    timeoutMs: 600_000,
  });

async function baseSide(repoPath: string, base: string): Promise<Side> {
  const dir = await baseCheckout(repoPath, base);
  try {
    const install = await installDeps(dir);
    if (install.ran && !install.passed) return "n/a";
    const res = await runTests(await packageManager(dir), dir).catch(
      () => null,
    );
    if (!res) return "n/a";
    return res.exitCode === 0 ? "green" : "red";
  } finally {
    await simpleGit(repoPath)
      .raw(["worktree", "remove", "--force", dir])
      .catch(() => "");
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function testRun(
  repoPath: string,
  isolation: Isolation,
  kind: ProofType,
  publish: Publish,
  proofDir: string,
): Promise<ProofRecord> {
  const dir = isolation.worktree;
  const lines: string[] = [];
  if (kind !== "test-run")
    lines.push(
      `${kind} has no proof runner yet; the test run stands in, and a person attaches the ${kind} proof`,
    );
  const pkg = await readFile(join(dir, "package.json"), "utf8")
    .then((t) => JSON.parse(t) as { scripts?: Record<string, string> })
    .catch(() => null);
  if (!pkg?.scripts?.test) {
    lines.push("tests: no test script to run (fails closed)");
    return { task: isolation.task, kind, passed: false, lines };
  }
  // The change's install or test command failing is a failed proof, not a crash.
  const install = await installDeps(dir);
  if (install.ran && !install.passed) {
    lines.push(`install failed: ${tail(install.output)}`);
    return { task: isolation.task, kind, passed: false, lines };
  }
  const pm = await packageManager(dir);
  let res: Awaited<ReturnType<typeof runTool>>;
  try {
    res = await runTests(pm, dir);
  } catch (err) {
    lines.push(`tests couldn't run: ${tail((err as Error).message)}`);
    return { task: isolation.task, kind, passed: false, lines };
  }
  let outcome: "pass" | "fail" | "pre-existing" | "flaky" =
    res.exitCode === 0 ? "pass" : "fail";
  if (outcome === "fail") {
    const retry = await runTests(pm, dir).catch(() => null);
    if (retry?.exitCode === 0) outcome = "flaky";
    else if (
      outcomeOf(await baseSide(repoPath, isolation.base), "red") ===
      "pre-existing"
    )
      outcome = "pre-existing";
  }
  const git = simpleGit(dir);
  const added = newTestNames(
    parseNameStatus(
      await git.raw(["diff", "--name-status", "-M", isolation.base, "HEAD"]),
    ),
    parseAddedLines(
      await git.raw(["diff", "-U0", "--no-color", isolation.base, "HEAD"]),
    ),
  );
  const passed = outcome !== "fail";
  const verdict = {
    pass: "tests passed",
    fail: "tests failed",
    flaky:
      "tests failed, then passed on one retry: flaky, not blamed on this change",
    "pre-existing":
      "tests failed on the change and on the base: pre-existing, not blamed on this change",
  }[outcome];
  lines.push(
    `${verdict} (${pm} run test, exit ${res.exitCode}) · new tests: ${added.join("; ") || "none"}`,
    `output: ${tail(`${res.stdout}\n${res.stderr}`)}`,
  );

  // The whole run goes to the evidence branch, beside any screenshots.
  const log = join(proofDir, "test-run.txt");
  await mkdir(proofDir, { recursive: true });
  await writeFile(
    log,
    `${pm} run test · exit ${res.exitCode}\nnew tests:\n${added.map((a) => `  ${a}`).join("\n") || "  none"}\n\n${res.stdout}\n${res.stderr}`,
    "utf8",
  );
  let published: Awaited<ReturnType<Publish>> = null;
  let notPushed = "no GitHub token or origin remote";
  try {
    published = await publish([log]);
  } catch (err) {
    notPushed = `upload failed: ${tail((err as Error).message, 200)}`;
  }
  lines.push(
    published?.[0]
      ? `evidence: the test run on the evidence branch: ${published[0].url}`
      : `evidence: the test run in ${TASKS_DIR}/${isolation.task}/proof/test-run.txt (not pushed: ${notPushed})`,
  );
  return {
    task: isolation.task,
    kind,
    passed,
    lines,
    tests: {
      exitCode: res.exitCode,
      added,
      output: `${res.stdout}\n${res.stderr}`.slice(-4000),
      outcome,
    },
  };
}

async function uiProof(
  repoPath: string,
  task: Task,
  isolation: Isolation,
  publish: Publish,
): Promise<ProofRecord> {
  const profile = await buildContext(repoPath)
    .profile()
    .catch(() => null);
  const start = profile?.proof?.start;
  if (!start)
    throw new TaskError(
      "the UI proof needs to know how to serve the app: set `proof.start` (and `proof.url` if it isn't http://localhost:{port}) in .rivetari/profile.yml",
    );
  const timeoutMs = (profile?.proof?.ready_timeout ?? 90) * 1000;
  const auth = profile?.proof?.auth;
  const pages = task.card.pages.length > 0 ? task.card.pages : ["/"];
  const outDir = join(repoPath, TASKS_DIR, task.card.id, "proof");
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const shots: NonNullable<ProofRecord["shots"]> = [];
  let violations: AxeViolation[] = [];
  /** Serve one side and shoot it; the server is always stopped. */
  const side = async (which: "before" | "after", dir: string) => {
    const install = await installDeps(dir);
    if (install.ran && !install.passed)
      throw new Error(`install failed: ${tail(install.output, 300)}`);
    const port =
      which === "before" ? isolation.port + BEFORE_PORT_OFFSET : isolation.port;
    const server = await startServer({
      command: start,
      cwd: dir,
      port,
      url: profile?.proof?.url,
      timeoutMs,
    });
    // The signed-in state holds a session: keep it out of the proof dir,
    // which is published, and delete it with the side.
    const stateDir = auth
      ? await mkdtemp(join(tmpdir(), "rivetari-proof-auth-"))
      : null;
    try {
      const storageState = stateDir ? join(stateDir, "state.json") : undefined;
      if (auth && storageState)
        await signIn({
          script: auth.script,
          root: repoPath,
          cwd: dir,
          baseUrl: server.url,
          port,
          stateFile: storageState,
        });
      const result = await shoot({
        baseUrl: server.url,
        pages,
        outDir,
        prefix: which,
        axe: which === "after",
        storageState,
      });
      shots.push(...result.shots.map((s) => ({ ...s, side: which })));
      if (which === "after") violations = result.violations;
    } finally {
      await server.stop();
      if (stateDir)
        await rm(stateDir, { recursive: true, force: true }).catch(
          () => undefined,
        );
    }
  };

  // The base failing to serve is the setup's problem: throw. The change
  // failing to serve is the change's: a failed proof, sent back to build.
  const before = await baseCheckout(repoPath, isolation.base);
  try {
    await side("before", before);
  } catch (err) {
    if (err instanceof AuthError)
      throw new TaskError(
        `signing in on the base failed, so proof.auth in .rivetari/profile.yml needs fixing: ${err.message}`,
      );
    throw err;
  } finally {
    await simpleGit(repoPath)
      .raw(["worktree", "remove", "--force", before])
      .catch(() => "");
    // Best-effort: Windows can hold a file open a moment after the server stops.
    await rm(before, { recursive: true, force: true }).catch(() => undefined);
  }
  try {
    await side("after", isolation.worktree);
  } catch (err) {
    const why = tail((err as Error).message, 600);
    return {
      task: task.card.id,
      kind: "ui-screenshots",
      passed: false,
      lines: [
        err instanceof AuthError
          ? `the change served, but signing in failed: ${why}`
          : `the change didn't serve: ${why}`,
      ],
      shots,
    };
  }

  // Evidence that can't be uploaded is still evidence: keep it local, say so.
  let published: Awaited<ReturnType<Publish>> = null;
  let notPushed = "no GitHub token or origin remote";
  try {
    published = await publish(shots.map((s) => s.file));
  } catch (err) {
    notPushed = `upload failed: ${tail((err as Error).message, 200)}`;
  }
  for (const p of published ?? []) {
    const shot = shots.find((s) => s.file === p.file);
    if (shot) shot.url = p.url;
  }
  // A page the change serves as an error isn't a page (a new page can 404 on
  // the base, so only the change's side counts).
  const broken = shots.filter((s) => s.side === "after" && s.status >= 400);
  const passed = violations.length === 0 && broken.length === 0;
  const lines = [
    `screenshots: ${pages.join(", ")} at sm/md/lg, before and after (${shots.length} images) ${
      published
        ? `on the evidence branch: ${task.card.id}/`
        : `in ${TASKS_DIR}/${task.card.id}/proof/ (not pushed: ${notPushed})`
    }`,
    violations.length === 0
      ? "axe: 0 serious or critical violations"
      : `axe: ${violations.length} serious or critical violation(s): ${violations.map((v) => `${v.id} on ${v.page} (${v.impact}, ${v.nodes})`).join("; ")}`,
    "visual diff: not automated yet; the before/after images are the comparison",
    ...(auth
      ? [`signed in: ${auth.script} ran on each side before its shots`]
      : []),
    ...(broken.length > 0
      ? [
          `pages that answered with an error: ${[...new Set(broken.map((s) => `${s.page} (${s.status})`))].join(", ")}`,
        ]
      : []),
  ];
  return {
    task: task.card.id,
    kind: "ui-screenshots",
    passed,
    lines,
    shots,
    violations,
  };
}

/** The default publisher: the repo's GitHub, when there's a token and an origin. */
function githubPublisher(repoPath: string, task: string): Publish {
  return async (files) => {
    const token = (await githubToken(repoPath))?.token;
    const slug = await resolveRepoSlug(repoPath);
    if (!token || !slug) return null;
    const gh = new Octokit({ auth: token, log: QUIET_LOG });
    return publishEvidence({
      gh: gh as unknown as EvidenceClient,
      owner: slug.owner,
      repo: slug.repo,
      task,
      files,
    });
  };
}

/**
 * `rivetari task prove <id>`: run the assembly's proof against the built
 * worktree and record it. A failed proof sends the task back to build.
 */
export async function proveTask(
  repoPath: string,
  id: string,
  options: ProveOptions,
): Promise<{ task: Task; record: ProofRecord }> {
  const task = await loadTask(repoPath, id);
  if (task.problems.length > 0)
    throw new TaskError(`task ${id} fails verification; not proving`);
  if (nextStep(task) !== "prove")
    throw new TaskError(`task ${id} isn't ready to prove: ${nextStep(task)}`);
  const isolation = await loadIsolation(repoPath, id);
  if (!isolation) throw new TaskError(`task ${id} has no worktree`);
  const assembly = AssemblySchema.parse(parse(task.assemblyText ?? ""));

  if (options.deferTestRun && assembly.proof === "test-run") {
    await task.ledger.append({
      beat: "prove",
      section: "timeline",
      text: DEFERRED,
      by: `rivetari runtime (for ${options.by})`,
      at: options.now,
    });
    return {
      task: await loadTask(repoPath, id),
      record: { task: id, kind: "test-run", passed: true, lines: [] },
    };
  }

  const proofDir = join(repoPath, TASKS_DIR, id, "proof");
  const publish = options.publish ?? githubPublisher(repoPath, id);
  const record =
    assembly.proof === "ui-screenshots"
      ? await uiProof(repoPath, task, isolation, publish)
      : await testRun(repoPath, isolation, assembly.proof, publish, proofDir);

  await mkdir(proofDir, { recursive: true });
  await writeFile(
    join(proofDir, "proof.json"),
    `${JSON.stringify(record, null, 2)}\n`,
    "utf8",
  );
  const by = `rivetari runtime (for ${options.by})`;
  for (const line of record.lines)
    await task.ledger.append({
      beat: "prove",
      section: "proof",
      text: line,
      by,
      at: options.now,
    });
  await task.ledger.append({
    beat: "prove",
    section: "timeline",
    text: `proof ${record.passed ? "passed" : "failed"} · ${record.kind}`,
    by,
    at: options.now,
  });
  return { task: await loadTask(repoPath, id), record };
}
