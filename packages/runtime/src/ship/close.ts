// The close beat: once a person has merged or closed the PR (or given
// up on the task), record the outcome with its duration, tokens and cost,
// remove the worktree, append a row to `.rivetari/history.jsonl`, and seal the
// ledger so nothing is written to it again.
import { access, appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildContext,
  type CiMinutes,
  githubToken,
  prCiMinutes,
} from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { parse } from "yaml";

import { loadIsolation } from "../agent/isolate.js";
import { stopTaskServers, teardownLine } from "../agent/processes.js";
import { type Finding, findingPattern } from "../judge/tier2.js";
import { AssemblySchema } from "../router/route.js";
import { isSeal, SEAL_TEXT } from "../task/ledger.js";
import {
  judgeVerdicts,
  loadTask,
  type Task,
  TaskError,
  TASKS_DIR,
} from "../task/tasks.js";

export interface PrState {
  state: "open" | "closed";
  merged: boolean;
  mergedBy?: string | undefined;
  mergedAt?: string | undefined;
  /** The minutes the PR's CI runs used, when they could be read. */
  ci?: CiMinutes | undefined;
}

export interface CloseOptions {
  by: string;
  now?: Date | undefined;
  /** Close without a merged PR, saying why. */
  abandon?: string | undefined;
  /** The PR's state (default: asked of the repo's GitHub). */
  prState?: ((pr: number) => Promise<PrState>) | undefined;
  /**
   * Updates the floorplan once a merged task is recorded, resolving its
   * ledger line or null (`floorplanOnMerge`). Passed in by the caller: the
   * floorplan calls the build agent's transport, which close can't import
   * without a cycle.
   */
  floorplan?: (() => Promise<string | null>) | undefined;
}

/** A task's row in `.rivetari/history.jsonl` (posture snapshots share the file). */
export interface TaskHistoryRow {
  kind: "task";
  date: string;
  task: string;
  type: string;
  outcome: "merged" | "closed" | "abandoned";
  pr: number | null;
  sectors: string[];
  skills: string[];
  minutes: number;
  tokens: number;
  cost_usd: number;
  build_rounds: number;
  judge_rounds: number;
  risk?: "low" | "medium" | "high" | undefined;
  prompt_tokens?: number | undefined;
  findings?: TaskFinding[] | undefined;
  rounds?: RoundUsage[] | undefined;
  /** GitHub Actions minutes the PR's runs used, per job rounded up. */
  ci_minutes?: number | undefined;
  ci_runs?: number | undefined;
}

export interface TaskFinding {
  pattern: string;
  kind: string;
  title: string;
}

export async function taskFindings(
  repoPath: string,
  id: string,
): Promise<TaskFinding[]> {
  const dir = join(repoPath, TASKS_DIR, id, "judge");
  const names = await readdir(dir).catch(() => [] as string[]);
  const seen = new Map<string, TaskFinding>();
  for (const name of names.filter((n) => /^round-\d+\.json$/.test(n)).sort()) {
    const record = JSON.parse(await readFile(join(dir, name), "utf8")) as {
      review?: { blocking?: Finding[]; suggestions?: Finding[] };
    };
    for (const f of [
      ...(record.review?.blocking ?? []),
      ...(record.review?.suggestions ?? []),
    ]) {
      const pattern = f.pattern ?? findingPattern(f.kind, f.title);
      if (!seen.has(pattern))
        seen.set(pattern, { pattern, kind: f.kind, title: f.title });
    }
  }
  return [...seen.values()];
}

const SHIPPED = /^draft PR (?:opened|updated): #(\d+)/;
/**
 * Where each entry carries its usage note, anchored on the runtime's own text
 * so an agent's summary (quoted after the note) can't add to the totals.
 */
const USAGE = String.raw`((?: · \d+ tokens)?(?: · \$\d+\.\d+)?(?: · \d+ turns)?(?: · retry)?)`;
const FLAGGED_NOTE = String.raw`(?: · \d+ decision\(s\) flagged for the PR \(autonomy [a-z-]+\))?`;
const ROUND_AT = [
  new RegExp(
    String.raw`^build paused: \d+ thing\(s\) to ask about · commit [0-9a-f]+${USAGE}$`,
  ),
  new RegExp(
    String.raw`^build done · commit [0-9a-f]+ · \d+ file\(s\) this round${FLAGGED_NOTE}${USAGE}`,
  ),
];
const USAGE_AT = [
  new RegExp(
    String.raw`^build started · .* repo file\(s\) in context${USAGE}$`,
  ),
  ...ROUND_AT,
  new RegExp(String.raw`^review round \d+: [a-z-]+; .*\)${USAGE}$`),
];

export interface RoundUsage {
  retry: boolean;
  tokens: number;
  turns: number | null;
}

export function roundUsage(task: Task): RoundUsage[] {
  return task.entries.flatMap((e) => {
    if (e.beat !== "build" || e.section !== "timeline") return [];
    const note = ROUND_AT.map((r) => r.exec(e.text)?.[1]).find(
      (n) => n !== undefined,
    );
    if (note === undefined) return [];
    const turns = / (\d+) turns/.exec(note)?.[1];
    return [
      {
        retry: note.includes(" · retry"),
        tokens: Number(/ (\d+) tokens/.exec(note)?.[1] ?? 0),
        turns: turns === undefined ? null : Number(turns),
      },
    ];
  });
}

/** Tokens and cost the ledger recorded for the agent and the judge. */
export function usageTotals(task: Task): { tokens: number; costUsd: number } {
  let tokens = 0;
  let costUsd = 0;
  for (const e of task.entries) {
    if (e.beat !== "build" && e.beat !== "judge") continue;
    const note = USAGE_AT.map((r) => r.exec(e.text)?.[1]).find(Boolean);
    if (!note) continue;
    tokens += Number(/ (\d+) tokens/.exec(note)?.[1] ?? 0);
    costUsd += Number(/\$(\d+\.\d+)/.exec(note)?.[1] ?? 0);
  }
  return { tokens, costUsd };
}

const PROMPT_TOKENS = /~(\d[\d,]*)(k?) prompt tokens/g;

export function promptTokens(task: Task): number | undefined {
  const figures = task.entries.flatMap((e) =>
    e.beat === "build" &&
    e.section === "timeline" &&
    e.text.startsWith("build started")
      ? [...e.text.matchAll(PROMPT_TOKENS)].map(
          (m) => Number(m[1]!.replace(/,/g, "")) * (m[2] ? 1000 : 1),
        )
      : [],
  );
  return figures.length > 0 ? Math.max(...figures) : undefined;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  const h = Math.floor(minutes / 60);
  return h > 0
    ? `${h}h${String(minutes % 60).padStart(2, "0")}m`
    : `${minutes}m`;
}

const kTokens = (n: number) =>
  n >= 1000 ? `${Math.round(n / 1000)}k tokens` : `${n} tokens`;

async function githubPrState(repoPath: string, pr: number): Promise<PrState> {
  const auth = await githubToken(repoPath);
  const gh = auth
    ? await buildContext(repoPath, { token: auth.token }).github()
    : null;
  if (!gh)
    throw new TaskError(
      "closing needs to see the PR: Rivetari's App installed on the repo, GITHUB_TOKEN or `gh auth login`, and an origin remote",
    );
  const { data } = await gh.octokit.rest.pulls.get({
    owner: gh.owner,
    repo: gh.repo,
    pull_number: pr,
  });
  // Only a decided PR's runs are worth counting, and a token without
  // actions: read just leaves the minutes out of the row.
  const ci =
    data.state === "open"
      ? undefined
      : await prCiMinutes(gh, pr).catch(() => undefined);
  return {
    state: data.state === "open" ? "open" : "closed",
    merged: data.merged,
    mergedBy: data.merged_by?.login,
    mergedAt: data.merged_at ?? undefined,
    ci,
  };
}

/**
 * `rivetari task close <id>`: after a person merges or closes the PR, or with
 * `abandon` at any point. Refuses while the PR is open: Rivetari never
 * merges, and a task isn't over until a person has decided.
 */
export async function closeTask(
  repoPath: string,
  id: string,
  options: CloseOptions,
): Promise<{ task: Task; row: TaskHistoryRow }> {
  const task = await loadTask(repoPath, id);
  if (task.problems.length > 0)
    throw new TaskError(`task ${id} fails verification; not closing`);
  const last = task.entries.at(-1);
  if (last && isSeal(last)) throw new TaskError(`task ${id} is already closed`);
  const now = options.now ?? new Date();
  const by = `rivetari runtime (for ${options.by})`;
  const append = (section: "timeline" | "outcome", text: string) =>
    task.ledger.append({ beat: "close", section, text, by, at: now });

  const shipped = [...task.entries]
    .reverse()
    .map((e) => (e.beat === "ship" ? SHIPPED.exec(e.text)?.[1] : undefined))
    .find((n) => n !== undefined);
  const pr = shipped ? Number(shipped) : null;

  // A close that stopped part-way already decided the outcome: finish it
  // without asking again or recording anything twice.
  const decided = task.entries.find(
    (e) => e.beat === "close" && e.section === "outcome",
  );
  let outcome: TaskHistoryRow["outcome"];
  let said = "";
  let ci: CiMinutes | undefined;
  const abandon = options.abandon?.replace(/\s+/g, " ").trim();
  if (decided) {
    outcome = decided.text.startsWith("abandoned")
      ? "abandoned"
      : /^PR #\d+ merged/.test(decided.text)
        ? "merged"
        : "closed";
  } else if (abandon !== undefined) {
    outcome = "abandoned";
    said = `abandoned${abandon ? `: ${abandon}` : ""}${pr ? ` (PR #${pr} is left as it is)` : ""}`;
  } else {
    if (pr === null)
      throw new TaskError(
        `task ${id} has no PR yet; ship it, or close it with --abandon "<why>"`,
      );
    const state = await (
      options.prState ?? ((n: number) => githubPrState(repoPath, n))
    )(pr);
    if (state.state === "open" && !state.merged)
      throw new TaskError(
        `PR #${pr} is still open; a person merges or closes it, then close the task (or --abandon "<why>")`,
      );
    outcome = state.merged ? "merged" : "closed";
    ci = state.ci;
    said = state.merged
      ? `PR #${pr} merged${state.mergedBy ? ` by ${state.mergedBy}` : ""}${state.mergedAt ? ` ${state.mergedAt.slice(0, 16).replace("T", " ")}` : ""}`
      : `PR #${pr} closed without merging`;
  }

  const started = new Date(task.entries[0]?.at ?? now);
  const ms = new Date(decided?.at ?? now).getTime() - started.getTime();
  const usage = usageTotals(task);
  if (!decided)
    await append(
      "outcome",
      `${said} · ${formatDuration(ms)} · ${kTokens(usage.tokens)} · $${usage.costUsd.toFixed(2)}`,
    );

  // The worktree goes, unless its work isn't merged and a tracked file has
  // uncommitted edits: the runtime commits everything the agent writes, so
  // those are a person's, and they're kept. (Untracked files after the last
  // round are install and proof output.) The branch goes only when merged.
  const isolation = await loadIsolation(repoPath, id).catch(() => null);
  // A closed task's port goes back to the pool, so whatever server it left
  // up goes first; on Windows a running server also keeps the worktree from
  // being removed.
  if (isolation) {
    const teardown = teardownLine(
      await stopTaskServers(isolation.worktree, [isolation.port]),
    );
    if (teardown) await append("timeline", teardown);
  }
  const present =
    isolation !== null &&
    (await access(isolation.worktree)
      .then(() => true)
      .catch(() => false));
  if (isolation && present) {
    const git = simpleGit(repoPath);
    const edited =
      outcome !== "merged" &&
      (
        await simpleGit(isolation.worktree)
          .raw(["status", "--porcelain", "--untracked-files=no"])
          .catch(() => "unknown")
      ).trim() !== "";
    const removed =
      !edited &&
      (await git
        .raw(["worktree", "remove", "--force", isolation.worktree])
        .then(() => true)
        .catch(() => false));
    const deleted =
      removed &&
      outcome === "merged" &&
      (await git
        .raw(["branch", "-D", isolation.branch])
        .then(() => true)
        .catch(() => false));
    await append(
      "timeline",
      `${removed ? "worktree removed" : `worktree ${isolation.worktree} kept: ${edited ? "it has uncommitted edits" : "it couldn't be removed"}; remove it by hand`} · branch ${isolation.branch} ${deleted ? "deleted" : "kept"}`,
    );
  }

  // A merged change belongs on the map. Its failure is a line in the ledger,
  // never a reason not to close; a close that stopped part-way doesn't redo it.
  if (
    options.floorplan &&
    outcome === "merged" &&
    !task.entries.some(
      (e) => e.beat === "close" && e.text.startsWith("floorplan "),
    )
  ) {
    const line = await options
      .floorplan()
      .catch(
        (err: Error) =>
          `floorplan update failed (close goes on): ${err.message.replace(/\s+/g, " ").slice(0, 300)}`,
      );
    if (line) await append("timeline", line);
  }

  const assembly = task.assemblyText
    ? AssemblySchema.safeParse(parse(task.assemblyText))
    : null;
  const prompt = promptTokens(task);
  const row: TaskHistoryRow = {
    kind: "task",
    date: now.toISOString().slice(0, 10),
    task: id,
    type: task.card.type,
    outcome,
    pr,
    sectors: assembly?.success ? assembly.data.sectors : [],
    skills: assembly?.success ? assembly.data.skills : [],
    minutes: Math.round(ms / 60_000),
    tokens: usage.tokens,
    cost_usd: Math.round(usage.costUsd * 100) / 100,
    build_rounds: task.entries.filter(
      (e) =>
        e.beat === "build" &&
        e.section === "timeline" &&
        /^build (done|paused)/.test(e.text),
    ).length,
    judge_rounds: judgeVerdicts(task).length,
    risk: task.card.risk,
    ...(prompt === undefined ? {} : { prompt_tokens: prompt }),
    findings: await taskFindings(repoPath, id),
    rounds: roundUsage(task),
    ...(ci ? { ci_minutes: ci.minutes, ci_runs: ci.runs } : {}),
  };
  const historyPath = join(repoPath, ".rivetari", "history.jsonl");
  const written = (await readFile(historyPath, "utf8").catch(() => ""))
    .split("\n")
    .some((line) => {
      try {
        const r = JSON.parse(line) as Partial<TaskHistoryRow>;
        return r.kind === "task" && r.task === id;
      } catch {
        return false;
      }
    });
  if (!written) {
    await mkdir(join(repoPath, ".rivetari"), { recursive: true });
    await appendFile(historyPath, `${JSON.stringify(row)}\n`, "utf8");
  }
  await append("timeline", `${SEAL_TEXT} · ${outcome}`);
  return { task: await loadTask(repoPath, id), row };
}
