// Watching a repo's tasks without touching them: the desktop shell's Tasks tab
// shows what `rivetari task status` would, as it changes. The record is read
// the way `pullTasks` would bring it in — the rivetari/tasks branch's copy of
// each task, unless this machine's `.rivetari/tasks/<id>/` holds work the
// branch has never had, or the task is only here — but nothing is fetched,
// no ref moves and nothing under `.rivetari/` is written. Each task's record
// files are copied to a scratch directory and loaded from there, so even the
// ledger.md re-render `loadTask` can do lands outside the repo.
import {
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

import { simpleGit } from "simple-git";

import { usageTotals } from "../ship/close.js";
import { TASK_ID } from "./card.js";
import { type Beat, isSeal, type LedgerEntry } from "./ledger.js";
import { type Lease, pushedBefore, readBlob, TASKS_BRANCH } from "./store.js";
import {
  judgeVerdicts,
  loadTask,
  nextStep,
  openStops,
  type Task,
  TASKS_DIR,
} from "./tasks.js";

/** The files a task's view is read from; judge records and proof stay put. */
const RECORD = [
  "card.yml",
  "assembly.yml",
  "ledger.jsonl",
  "ledger.md",
  "lease.json",
];
const SHIPPED = /^draft PR (?:opened|updated): #(\d+) (\S+)/;
/** How often the watcher looks again, unless told otherwise. */
export const WATCH_INTERVAL_MS = 2000;

/** Why a task is waiting on a person, in the order `nextStep` checks them. */
export type NeedsYouKind = "record" | "stop" | "judge" | "intake" | "route";

export interface TaskView {
  id: string;
  title: string;
  type: string;
  risk: string;
  owner: string;
  beat: Beat;
  /** What happens next, as `rivetari task status` says it. */
  next: string;
  /** The ledger is sealed: the task is closed. */
  done: boolean;
  /** Which copy this view was read from. */
  source: "branch" | "local";
  lease: Lease | null;
  buildRounds: number;
  judgeRounds: number;
  tokens: number;
  costUsd: number;
  pr: { number: number; url: string } | null;
  needsYou: { kind: NeedsYouKind; why: string } | null;
  problems: string[];
  entries: LedgerEntry[];
}

export type TaskEvent =
  | { kind: "snapshot"; tasks: TaskView[] }
  | { kind: "added"; task: TaskView }
  | {
      kind: "changed";
      task: TaskView;
      /** Entries appended since the last view of it. */
      newEntries: LedgerEntry[];
      previousBeat: Beat;
      /** The ledger was sealed since the last view. */
      closed: boolean;
    }
  | { kind: "removed"; id: string }
  | { kind: "error"; message: string };

function needsYou(task: Task, done: boolean): TaskView["needsYou"] {
  if (done) return null;
  if (task.problems.length > 0)
    return {
      kind: "record",
      why: `the record fails verification: ${task.problems.join("; ")}`,
    };
  const stops = openStops(task);
  // The judge escalates by asking, so its question is a stop like the build's.
  const judge = stops.find((s) => s.startsWith("judge: "));
  if (judge) return { kind: "judge", why: judge.slice("judge: ".length) };
  if (stops.length > 0) return { kind: "stop", why: stops.join("; ") };
  if (!task.confirmed)
    return { kind: "intake", why: "the card is waiting to be confirmed" };
  if (!task.approved && task.assemblyText !== undefined)
    return { kind: "route", why: "the proposed route is waiting for approval" };
  return null;
}

function viewOf(
  task: Task,
  source: TaskView["source"],
  lease: Lease | null,
): TaskView {
  const last = task.entries.at(-1);
  const done = last !== undefined && isSeal(last);
  const shipped = [...task.entries]
    .reverse()
    .map((e) => (e.beat === "ship" ? SHIPPED.exec(e.text) : null))
    .find((m) => m !== null);
  const usage = usageTotals(task);
  return {
    id: task.card.id,
    title: task.card.title,
    type: task.card.type,
    risk: task.card.risk,
    owner: task.card.owner,
    beat: task.beat,
    next: nextStep(task),
    done,
    source,
    lease,
    // Counted the way the close beat counts them for the history row.
    buildRounds: task.entries.filter(
      (e) =>
        e.beat === "build" &&
        e.section === "timeline" &&
        /^build (done|paused)/.test(e.text),
    ).length,
    judgeRounds: judgeVerdicts(task).length,
    tokens: usage.tokens,
    costUsd: usage.costUsd,
    pr: shipped ? { number: Number(shipped[1]), url: shipped[2]! } : null,
    needsYou: needsYou(task, done),
    problems: task.problems,
    entries: task.entries,
  };
}

/**
 * What a read gives, or null when the file isn't there. Any other failure (a
 * Windows indexer holding the file, a permission) is passed on, so the task
 * keeps its last view and is read again, rather than looking gone.
 */
const ifThere = <T>(read: Promise<T>): Promise<T | null> =>
  read.catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });

const isLease = (value: unknown): value is Lease =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Lease).holder === "string" &&
  typeof (value as Lease).expires === "string";

const byNumber = (a: string, b: string) =>
  Number(a.slice(2)) - Number(b.slice(2));

/**
 * Reads task views, remembering each task's by what it was read from, so a
 * poll only reloads the tasks that moved.
 */
class TaskReader {
  private scratch: string | undefined;
  /** A null view is a reserved id with no card yet, so it isn't reloaded each poll. */
  private readonly seen = new Map<
    string,
    { key: string; view: TaskView | null }
  >();
  private readonly failed = new Map<string, string>();

  constructor(
    private readonly repo: string,
    private readonly onError: (message: string) => void,
  ) {}

  /** The branch tip as this machine last saw it: origin's when it's been fetched. */
  private async tip(): Promise<string | null> {
    const git = simpleGit(this.repo);
    // A folder that isn't a repo has no branch, only this machine's copies; any
    // other git failure is passed on, or the branch's tasks would silently go.
    if (!(await git.checkIsRepo())) return null;
    const refs = await git.raw([
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      `refs/remotes/origin/${TASKS_BRANCH}`,
      `refs/heads/${TASKS_BRANCH}`,
    ]);
    const shas = new Map(
      refs
        .split("\n")
        .filter(Boolean)
        .map((l) => l.split(" ") as [string, string]),
    );
    return (
      shas.get(`refs/remotes/origin/${TASKS_BRANCH}`) ??
      shas.get(`refs/heads/${TASKS_BRANCH}`) ??
      null
    );
  }

  /** Each task on the branch, with its subtree's id: a changed task has a new one. */
  private async branchTrees(tip: string | null): Promise<Map<string, string>> {
    if (!tip) return new Map();
    const out = await simpleGit(this.repo).raw(["ls-tree", "-z", tip]);
    const trees = new Map<string, string>();
    for (const line of out.split("\0").filter(Boolean)) {
      // "<mode> tree <sha>\t<name>"
      const [meta = "", name = ""] = line.split("\t");
      if (TASK_ID.test(name)) trees.set(name, meta.split(" ")[2] ?? "");
    }
    return trees;
  }

  /** This machine's copy of a task, as sizes and times: cheap to compare each poll. */
  private async localStamp(id: string): Promise<string | null> {
    const dir = join(this.repo, TASKS_DIR, id);
    const parts = await Promise.all(
      RECORD.map((f) =>
        stat(join(dir, f)).then(
          (s) => `${f}:${s.size}:${s.mtimeMs}`,
          () => "",
        ),
      ),
    );
    return parts.some(Boolean) ? parts.join("|") : null;
  }

  private async load(
    id: string,
    source: TaskView["source"],
    tip: string | null,
  ): Promise<TaskView | null> {
    this.scratch ??= await mkdtemp(join(tmpdir(), "rivetari-watch-"));
    const dir = join(this.scratch, TASKS_DIR, id);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    for (const f of RECORD) {
      const data =
        source === "branch" && tip
          ? await readBlob(this.repo, tip, `${id}/${f}`)
          : await ifThere(readFile(join(this.repo, TASKS_DIR, id, f)));
      if (data) await writeFile(join(dir, f), data);
    }
    // A reserved id with no card yet isn't a task to show.
    if (
      !(await stat(join(dir, "card.yml")).then(
        () => true,
        () => false,
      ))
    )
      return null;
    const leaseText = await ifThere(readFile(join(dir, "lease.json"), "utf8"));
    let lease: Lease | null = null;
    if (leaseText !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(leaseText);
      } catch {
        // reported below
      }
      if (isLease(parsed)) lease = parsed;
      else
        this.onError(
          `${id}: lease.json isn't a lease (a holder and an expiry); showing no lease`,
        );
    }
    return viewOf(await loadTask(this.scratch, id), source, lease);
  }

  /** Every task as it stands now, oldest first. */
  async read(): Promise<TaskView[]> {
    const tip = await this.tip();
    const trees = await this.branchTrees(tip);
    const local = (
      (await ifThere(readdir(join(this.repo, TASKS_DIR)))) ?? []
    ).filter((n) => TASK_ID.test(n));
    const ids = [...new Set([...trees.keys(), ...local])].sort(byNumber);
    const views: TaskView[] = [];
    for (const id of ids) {
      const stamp = local.includes(id) ? await this.localStamp(id) : null;
      const key = `${tip ? (trees.get(id) ?? "") : ""}|${stamp ?? ""}`;
      const cached = this.seen.get(id);
      if (cached?.key === key) {
        if (cached.view) views.push(cached.view);
        continue;
      }
      try {
        const tree = trees.get(id);
        const source =
          tree === undefined ||
          (stamp !== null &&
            tip !== null &&
            !(await pushedBefore(this.repo, tip, id)))
            ? "local"
            : "branch";
        const view = await this.load(id, source, tip);
        if (view) views.push(view);
        this.seen.set(id, { key, view });
        this.failed.delete(id);
      } catch (err) {
        // Most often a ledger read half-way through an append: keep the last
        // view, don't remember the key, and look again next time. Said once.
        const message = `${id}: ${(err as Error).message}`;
        if (this.failed.get(id) !== message) this.onError(message);
        this.failed.set(id, message);
        if (cached?.view) views.push(cached.view);
      }
    }
    for (const id of this.seen.keys())
      if (!ids.includes(id)) this.seen.delete(id);
    return views;
  }

  async close(): Promise<void> {
    if (this.scratch) await rm(this.scratch, { recursive: true, force: true });
    this.scratch = undefined;
    this.seen.clear();
  }
}

/** Every task in `repo` as it stands now, read without writing anything. */
export async function readTasks(
  repo: string,
  onError: (message: string) => void = () => undefined,
): Promise<TaskView[]> {
  const reader = new TaskReader(repo, onError);
  try {
    return await reader.read();
  } finally {
    await reader.close();
  }
}

export interface TaskWatcher {
  /** The first snapshot, once it's been read. */
  ready: Promise<TaskView[]>;
  /** Stop polling and remove the scratch copies; nothing is emitted after it resolves. */
  stop(): Promise<void>;
}

/**
 * Stream the tasks in `repo`: a `snapshot` first, then `added`, `changed`
 * (with the entries appended since) and `removed` as they happen, read every
 * `intervalMs`. Polling rather than file watching, because a task moves on
 * the branch as well as on disk, and git has no portable change feed.
 */
export function watchTasks(
  repo: string,
  onEvent: (event: TaskEvent) => void,
  options: { intervalMs?: number } = {},
): TaskWatcher {
  const interval = options.intervalMs ?? WATCH_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let current = new Map<string, TaskView>();
  let snapshotted = false;
  const emit = (event: TaskEvent) => {
    if (stopped) return;
    try {
      onEvent(event);
    } catch {
      // A listener's own failure is its to handle: it mustn't stop the polling
      // or leave `ready` unsettled.
    }
  };
  const reader = new TaskReader(repo, (message) =>
    emit({ kind: "error", message }),
  );

  let settle: {
    resolve: (t: TaskView[]) => void;
    reject: (e: unknown) => void;
  };
  const ready = new Promise<TaskView[]>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A caller that only listens for events needn't handle a failed first read.
  ready.catch(() => undefined);

  const cycle = async () => {
    let views: TaskView[];
    try {
      views = await reader.read();
    } catch (err) {
      emit({ kind: "error", message: (err as Error).message });
      if (!snapshotted) settle.reject(err);
      return;
    }
    if (stopped) return;
    const next = new Map(views.map((v) => [v.id, v]));
    if (!snapshotted) {
      snapshotted = true;
      current = next;
      settle.resolve(views);
      emit({ kind: "snapshot", tasks: views });
      return;
    }
    for (const view of views) {
      const was = current.get(view.id);
      if (!was) emit({ kind: "added", task: view });
      else if (was !== view && JSON.stringify(was) !== JSON.stringify(view)) {
        const lastSeq = was.entries.at(-1)?.seq ?? 0;
        emit({
          kind: "changed",
          task: view,
          newEntries: view.entries.filter((e) => e.seq > lastSeq),
          previousBeat: was.beat,
          closed: view.done && !was.done,
        });
      }
    }
    for (const id of current.keys())
      if (!next.has(id)) emit({ kind: "removed", id });
    current = next;
  };

  let running: Promise<void> = Promise.resolve();
  const tick = () => {
    running = cycle().finally(() => {
      if (!stopped) timer = setTimeout(tick, interval);
    });
  };
  tick();

  return {
    ready,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      try {
        await running;
      } finally {
        // Stopped before the first read landed: whoever awaits `ready` hears so.
        if (!snapshotted)
          settle.reject(new Error("the watcher stopped before its first read"));
        await reader.close();
      }
    },
  };
}
