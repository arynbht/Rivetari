// The build beat: plan first (read-only, written to the ledger
// before any edit), then one writer in the task's worktree, then the runtime
// commits and checks the diff for stop-and-ask triggers. A trigger pauses the
// task until a person answers; an allowed trigger isn't asked about again.
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  agentEnv,
  BUILD_TOOLS,
  claudeCommand,
  DENIED_BUILD_TOOLS,
  extractJson,
  ISOLATED_AGENT_ARGS,
  parseClaudeJson,
  READ_ONLY_TOOLS,
  spawnWithLimit,
} from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { parse } from "yaml";
import { z } from "zod";

import { fastPlan, isFastPath, sourceTouches } from "../judge/fast-path.js";
import { isGeneratedPath } from "../judge/tier2.js";
import { AssemblySchema } from "../router/route.js";
import {
  allowedStops,
  ANSWERED,
  loadTask,
  openStops,
  type Task,
  TaskError,
} from "../task/tasks.js";
import { autonomyFor, isSoftStop } from "../task/autonomy.js";
import { type Isolation, loadIsolation } from "./isolate.js";
import { assemblePrompt, STOP_MARKER } from "./prompt.js";
import { findStops, type Stop, withLicenses } from "./stops.js";

export interface AgentCall {
  mode: "plan" | "build";
  system: string;
  prompt: string;
  cwd: string;
  model?: string | undefined;
  env: NodeJS.ProcessEnv;
  /** The most model replies the call may take (`claude --max-turns`). */
  maxTurns?: number | undefined;
}

/** An agent call's final text, with what it cost when the runner knows. */
export interface AgentReply {
  text: string;
  tokens?: number | undefined;
  costUsd?: number | undefined;
  /**
   * The CLI's `num_turns`. It counts the prompt and every tool result, so a
   * reply that ran parallel tool calls reports more than `--max-turns`, which
   * counts model replies.
   */
  turns?: number | undefined;
  /** The turn limit the call stopped at before it replied, when it did. */
  turnLimit?: number | undefined;
}

/** Runs one agent call and resolves its final text (or a reply with usage). */
export type AgentRunner = (call: AgentCall) => Promise<string | AgentReply>;

/** " · 12345 tokens · $0.42" for the ledger, or "" when unknown. */
export function usageNote(reply: AgentReply, retry = false): string {
  return `${reply.tokens ? ` · ${reply.tokens} tokens` : ""}${reply.costUsd ? ` · $${reply.costUsd.toFixed(2)}` : ""}${reply.turns ? ` · ${reply.turns} turns` : ""}${retry ? " · retry" : ""}`;
}

const asReply = (r: string | AgentReply): AgentReply =>
  typeof r === "string" ? { text: r } : r;

export const PLAN_TURNS = 4;

/**
 * Subagents' turns don't count toward the caller's --max-turns, and the Agent
 * tool needs no approval, so a capped call would spend them there instead.
 */
const SUBAGENT_TOOLS = ["Agent", "Task"];

/** How a plan call's turn-limit stop starts, so its answer can be found. */
const OUT_OF_TURNS = "the plan call reached its";

/** What the CLI reports when a call stops at --max-turns before replying. */
const MAX_TURNS = "error_max_turns";

const hitTurnLimit = (stdout: string): boolean => {
  try {
    return (JSON.parse(stdout) as { subtype?: unknown }).subtype === MAX_TURNS;
  } catch {
    return false;
  }
};

export function agentArgs(call: AgentCall): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    ...(call.model ? ["--model", call.model] : []),
    ...ISOLATED_AGENT_ARGS,
    "--append-system-prompt",
    call.system,
    ...(call.mode === "build"
      ? [
          "--permission-mode",
          "acceptEdits",
          "--allowedTools",
          BUILD_TOOLS.join(","),
          "--disallowedTools",
          DENIED_BUILD_TOOLS.join(","),
        ]
      : ["--allowedTools", READ_ONLY_TOOLS.join(",")]),
    ...(call.maxTurns
      ? [
          "--max-turns",
          String(call.maxTurns),
          ...(call.mode === "plan"
            ? ["--disallowedTools", SUBAGENT_TOOLS.join(",")]
            : []),
        ]
      : []),
  ];
}

export const claudeAgent: AgentRunner = async (call) => {
  const { command, argv } = await claudeCommand(agentArgs(call));
  const stdout = await spawnWithLimit(command, argv, {
    input: call.prompt,
    cwd: call.cwd,
    env: call.env,
    accept: hitTurnLimit,
  });
  // A call stopped at its turn limit has no reply, only what it cost.
  const limited = hitTurnLimit(stdout);
  const text = limited ? "" : parseClaudeJson(stdout, call.model ?? "").text;
  // The CLI's own totals: cache reads and writes included, cost as it reports it.
  const data = JSON.parse(stdout) as {
    total_cost_usd?: number;
    usage?: Record<string, number | undefined>;
    num_turns?: number;
  };
  const u = data.usage ?? {};
  const tokens = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ].reduce((sum, k) => sum + Number(u[k] ?? 0), 0);
  return {
    text,
    tokens: tokens || undefined,
    costUsd:
      typeof data.total_cost_usd === "number" ? data.total_cost_usd : undefined,
    turns: typeof data.num_turns === "number" ? data.num_turns : undefined,
    turnLimit: limited ? call.maxTurns : undefined,
  };
};

export function agentQuestion(text: string): string | undefined {
  const last = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  if (!last?.startsWith(STOP_MARKER)) return undefined;
  return last.slice(STOP_MARKER.length).trim() || undefined;
}

const oneLine = (text: string, max: number) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

async function worktreeTree(worktree: string): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), "rivetari-tree-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(scratch, "index") };
  const git = (args: string[]) =>
    promisify(execFile)("git", args, { cwd: worktree, env, windowsHide: true });
  try {
    await git(["read-tree", "HEAD"]);
    await git(["add", "-A"]);
    return (await git(["write-tree"])).stdout.trim();
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

const CHANGE_CHARS = 32_000;

async function changeSoFar(isolation: Isolation): Promise<string> {
  const wt = simpleGit(isolation.worktree);
  const changed = (await wt.raw(["diff", "--name-only", isolation.base]))
    .split("\n")
    .filter(Boolean);
  const generated = changed.filter(isGeneratedPath);
  const source = changed.filter((p) => !isGeneratedPath(p));
  const diff =
    source.length > 0
      ? await wt.raw(["diff", "--no-color", isolation.base, "--", ...source])
      : "";
  const cut =
    diff.length > CHANGE_CHARS
      ? `${diff.slice(0, CHANGE_CHARS)}\n… cut at ${CHANGE_CHARS} characters; read the rest from the worktree`
      : diff.trimEnd();
  const untracked = (
    await wt.raw(["ls-files", "--others", "--exclude-standard"])
  ).trim();
  return [
    cut,
    generated.length > 0
      ? `Generated files changed too (not shown): ${generated.join(", ")}`
      : "",
    untracked ? `New files not shown above:\n${untracked}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

const PLAN_SYSTEM =
  'Plan the task below before anyone edits a file. Read what you need; change nothing. Reply with ONLY a JSON object: {"steps": ["one concrete step", ...]}. Keep within the budget in the operating rules.';
const PlanSchema = z.object({ steps: z.array(z.string().min(1)).min(1) });

const ROUND_END = /^build (done|paused)/;
const PLAN_START = /^build started/;

/**
 * The answer the next round has to act on: one given since the last build
 * round ended, with the stops it answered. An older answer was acted on already.
 */
function pendingAnswer(
  task: Task,
): { allowed: boolean; note: string; stops: string[] } | null {
  let roundEnd = -1;
  task.entries.forEach((e, i) => {
    // A replan after a budget denial (build started) acts on it too.
    if (
      e.section === "timeline" &&
      (ROUND_END.test(e.text) || PLAN_START.test(e.text))
    )
      roundEnd = i;
  });
  let asked: string[] = [];
  let pending: { allowed: boolean; note: string; stops: string[] } | null =
    null;
  task.entries.forEach((e, i) => {
    if (e.section !== "stop") return;
    if (e.text.startsWith("asked: ")) {
      asked.push(e.text.slice("asked: ".length));
      return;
    }
    const m = ANSWERED.exec(e.text);
    if (!m) return;
    if (i > roundEnd)
      pending = { allowed: m[1] === "allowed", note: m[2] ?? "", stops: asked };
    asked = [];
  });
  return pending;
}

/** Judge lines the agent acts on: failed checks, blocking findings, unmet criteria. */
const JUDGE_FEEDBACK = /^(tier 1 fail|blocking|acceptance \S+: unmet)/;

/**
 * What the last proof or judge said, when it sent the change back after the
 * last build round.
 */
function sentBack(task: Task): string | undefined {
  let roundEnd = -1;
  task.entries.forEach((e, i) => {
    if (e.section === "timeline" && ROUND_END.test(e.text)) roundEnd = i;
  });
  const after = task.entries.slice(roundEnd + 1);
  const verdict = [...after]
    .reverse()
    .find(
      (e) =>
        (e.beat === "prove" || e.beat === "judge") && e.section === "timeline",
    );
  if (verdict?.text.startsWith("proof failed")) {
    const lines = after
      .filter((e) => e.beat === "prove" && e.section === "proof")
      .map((e) => e.text);
    return `the proof failed; fix the change so it passes — ${lines.join(" | ")}`;
  }
  if (verdict?.text.startsWith("judge failed")) {
    const lines = after
      .filter((e) => e.section === "judge" && JUDGE_FEEDBACK.test(e.text))
      .map((e) => e.text);
    return `the judge sent the change back; fix these and nothing else — ${lines.join(" | ")}. A tier 1 failure is fixed by changing the code that triggered it, never by deleting something that existed at base.`;
  }
  return undefined;
}

/** The latest plan: the plan entries after the last "build started". */
function plan(task: Task): string[] {
  let start = -1;
  task.entries.forEach((e, i) => {
    if (e.section === "timeline" && PLAN_START.test(e.text)) start = i;
  });
  return task.entries
    .slice(start + 1)
    .filter((e) => e.section === "plan")
    .map((e) => e.text.replace(/^\d+\. /, ""));
}

export interface BuildOutcome {
  task: Task;
  /** Stops raised this round; empty when the build finished. */
  stops: Stop[];
  flagged?: Stop[] | undefined;
  commit?: string | undefined;
}

/**
 * `rivetari task build <id>`: plan (once), build, commit, check. Returns the
 * stops it raised; the task waits on `rivetari task answer` until they're answered.
 */
export async function buildTask(
  repoPath: string,
  id: string,
  options: {
    by: string;
    agent?: AgentRunner | undefined;
    model?: string | undefined;
    now?: Date | undefined;
  },
): Promise<BuildOutcome> {
  const agent = options.agent ?? claudeAgent;
  let task = await loadTask(repoPath, id);
  if (task.problems.length > 0)
    throw new TaskError(`task ${id} fails verification; not building`);
  const isolation = await loadIsolation(repoPath, id);
  if (!isolation)
    throw new TaskError(
      `task ${id} has no worktree: \`rivetari task isolate ${id}\``,
    );
  if (openStops(task).length > 0)
    throw new TaskError(
      `task ${id} is waiting on an answer: \`rivetari task answer ${id} --allow|--deny\``,
    );
  const assembly = AssemblySchema.parse(parse(task.assemblyText ?? ""));
  const by = `rivetari runtime (for ${options.by})`;
  const log = (section: "timeline" | "plan" | "stop", text: string) =>
    task.ledger.append({ beat: "build", section, text, by, at: options.now });
  const env = taskEnv(isolation);

  const answer = pendingAnswer(task);
  // A denied over-budget plan is replanned, never run.
  const replan =
    answer !== null &&
    !answer.allowed &&
    answer.stops.some((s) => s.startsWith("budget_exhausted"));
  // A plan call that ran out of turns plans again either way: allowed, with
  // twice the turns; denied, within the limit, told to read less.
  const outOfTurns =
    answer !== null &&
    answer.stops.some((s) => s.startsWith(`budget_exhausted: ${OUT_OF_TURNS}`));

  // Plan first, recorded before any edit.
  let steps = replan || outOfTurns ? [] : plan(task);
  if (steps.length === 0 && !replan && !outOfTurns && isFastPath(task.card)) {
    steps = fastPlan(task.card);
    await log(
      "timeline",
      `build started · fast path (low risk, ${sourceTouches(task.card).length} source file(s)): planned from the card's criteria, no plan call · budget ${assembly.budget.steps} steps / ${assembly.budget.context_tokens / 1000}k ctx`,
    );
    for (const [i, step] of steps.entries())
      await log("plan", `${i + 1}. ${step}`);
  }
  if (steps.length === 0) {
    const planning = await assemblePrompt({
      repoPath,
      card: task.card,
      assembly,
      isolation,
      answer: outOfTurns
        ? `your last plan call ran out of turns before it replied — ${answer.note || "read only what the plan needs, then reply"}`
        : replan
          ? `your plan was over budget and was refused — ${answer.note || "plan fewer, larger steps"}`
          : undefined,
    });
    const reply = asReply(
      await agent({
        mode: "plan",
        system: PLAN_SYSTEM,
        prompt: planning.prompt,
        cwd: isolation.worktree,
        model: options.model,
        env,
        maxTurns: outOfTurns && answer.allowed ? PLAN_TURNS * 2 : PLAN_TURNS,
      }),
    );
    const started = `build started · skills ${planning.skills.join(", ") || "spine only"} · budget ${assembly.budget.steps} steps / ${assembly.budget.context_tokens / 1000}k ctx · ~${planning.approxTokens} prompt tokens · ${planning.files.length} repo file(s) in context${usageNote(reply)}`;
    if (reply.turnLimit) {
      // Logged as a start with no plan, so what the call cost is counted.
      await log("timeline", started);
      const stop: Stop = {
        trigger: "budget_exhausted",
        detail: `${OUT_OF_TURNS} ${reply.turnLimit}-turn limit before it replied with a plan; allow to plan again with ${PLAN_TURNS * 2} turns, or deny to plan again within ${PLAN_TURNS}`,
      };
      await log("stop", `asked: ${stop.trigger}: ${stop.detail}`);
      return { task: await loadTask(repoPath, id), stops: [stop] };
    }
    steps = PlanSchema.parse(extractJson(reply.text)).steps;
    await log("timeline", started);
    for (const [i, step] of steps.entries())
      await log("plan", `${i + 1}. ${step}`);
    if (steps.length > assembly.budget.steps) {
      const stop: Stop = {
        trigger: "budget_exhausted",
        detail: `the plan has ${steps.length} steps; the budget is ${assembly.budget.steps}`,
      };
      await log("stop", `asked: ${stop.trigger}: ${stop.detail}`);
      return { task: await loadTask(repoPath, id), stops: [stop] };
    }
  }

  const answeredQuestion =
    answer?.stops.some((s) => s.startsWith("agent_question:")) ?? false;
  const since =
    answer && answeredQuestion
      ? `a person answered your question (${answer.allowed ? "allowed" : "denied"})${answer.note ? `: ${answer.note}` : ""}`
      : answer && !answer.allowed && !replan
        ? `denied — ${answer.note || "undo what you asked about"}`
        : sentBack(task);
  const retry =
    since !== undefined &&
    !replan &&
    task.entries.some(
      (e) => e.section === "timeline" && ROUND_END.test(e.text),
    );
  const building = await assemblePrompt({
    repoPath,
    card: task.card,
    assembly,
    isolation,
    plan: steps,
    answer: since,
    change: retry ? await changeSoFar(isolation) : undefined,
  });
  const wt = simpleGit(isolation.worktree);
  const before = (await wt.revparse(["HEAD"])).trim();
  const untouched = await worktreeTree(isolation.worktree);
  const call = {
    mode: "build" as const,
    system: building.system,
    cwd: isolation.worktree,
    model: options.model,
    env,
  };
  const reply = asReply(await agent({ ...call, prompt: building.prompt }));

  const question = agentQuestion(reply.text);
  if (question) {
    const stop: Stop = {
      trigger: "agent_question",
      detail: oneLine(question, 500),
    };
    await log("stop", `asked: ${stop.trigger}: ${stop.detail}`);
    await log(
      "timeline",
      `build paused: 1 thing(s) to ask about · commit ${before.slice(0, 12)}${usageNote(reply, retry)}`,
    );
    return {
      task: await loadTask(repoPath, id),
      stops: [stop],
      commit: before,
    };
  }

  const changed = untouched !== (await worktreeTree(isolation.worktree));
  // The runtime commits, with hooks off (the worktree's hooksPath is empty).
  const staged = changed
    ? await wt
        .add(["-A"])
        .then(() => wt.raw(["diff", "--cached", "--name-only"]))
        .then((s) => s.trim())
    : "";
  if (staged)
    await wt.commit(
      `${task.card.type}(${id.toLowerCase()}): ${task.card.title}`,
      ["--no-verify"],
    );
  const head = (await wt.revparse(["HEAD"])).trim();

  task = await loadTask(repoPath, id);
  const allowed = allowedStops(task);
  const found = await findStops(
    isolation.worktree,
    isolation.base,
    head,
    assembly,
  );
  const level = await autonomyFor(repoPath, task.card);
  const raised = (
    level === "supervised"
      ? found
      : await Promise.all(found.map((s) => withLicenses(isolation.worktree, s)))
  ).filter((s) => !allowed.has(`${s.trigger}: ${s.detail}`));
  const descends = await wt
    .raw(["merge-base", "--is-ancestor", before, head])
    .then(
      () => true,
      () => false,
    );
  if (!descends)
    raised.push({
      trigger: "history_rewritten",
      detail: `the branch no longer contains ${before.slice(0, 12)}: its history was rewritten`,
    });
  if (head === before)
    raised.push({
      trigger: "no_change",
      detail:
        oneLine(reply.text, 500) ||
        "the agent changed nothing and said nothing",
    });
  const flagged =
    level === "supervised" ? [] : raised.filter((s) => isSoftStop(s));
  const stops = raised.filter((s) => !flagged.includes(s));
  for (const s of flagged)
    await log("stop", `flagged: ${s.trigger}: ${s.detail}`);
  for (const s of stops) await log("stop", `asked: ${s.trigger}: ${s.detail}`);
  await log(
    "timeline",
    stops.length > 0
      ? `build paused: ${stops.length} thing(s) to ask about · commit ${head.slice(0, 12)}${usageNote(reply, retry)}`
      : `build done · commit ${head.slice(0, 12)} · ${staged ? staged.split("\n").length : 0} file(s) this round${flagged.length > 0 ? ` · ${flagged.length} decision(s) flagged for the PR (autonomy ${level})` : ""}${usageNote(reply, retry)} · ${reply.text.trim().split("\n")[0]?.slice(0, 200) ?? ""}`,
  );
  const plain = (s: Stop): Stop => ({ trigger: s.trigger, detail: s.detail });
  return {
    task: await loadTask(repoPath, id),
    stops: stops.map(plain),
    flagged: flagged.map(plain),
    commit: head,
  };
}

/**
 * `rivetari task answer <id> --allow|--deny [note]`: a person answers the open
 * stops. Allowed: the task moves on (and isn't asked again). Denied: the next
 * build round gets the note and undoes it.
 */
export async function answerStops(
  repoPath: string,
  id: string,
  options: {
    allow: boolean;
    note?: string | undefined;
    by: string;
    now?: Date | undefined;
  },
): Promise<Task> {
  const task = await loadTask(repoPath, id);
  if (task.problems.length > 0)
    throw new TaskError(`task ${id} fails verification`);
  if (openStops(task).length === 0)
    throw new TaskError(`task ${id} has nothing waiting on an answer`);
  const note = options.note?.replace(/\s+/g, " ").trim();
  // The answer belongs to the beat that asked: build, or the judge.
  const asked = [...task.entries]
    .reverse()
    .find((e) => e.section === "stop" && e.text.startsWith("asked: "));
  await task.ledger.append({
    beat: asked?.beat === "judge" ? "judge" : "build",
    section: "stop",
    text: `answered: ${options.allow ? "allowed" : "denied"}${note ? ` — ${note}` : ""}`,
    by: options.by,
    at: options.now,
  });
  return loadTask(repoPath, id);
}

/**
 * The agent's environment: the engine's write-agent env (no caller tokens reach
 * the repo code it runs) plus the worktree's port and database.
 */
function taskEnv(isolation: Isolation): NodeJS.ProcessEnv {
  return agentEnv({
    PORT: String(isolation.port),
    RIVETARI_TASK: isolation.task,
    RIVETARI_DATABASE: isolation.database,
  });
}
