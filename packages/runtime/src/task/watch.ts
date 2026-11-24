// Watching a repo's tasks without touching them: the desktop shell's Tasks tab
// shows what `rivetari task status` would, as it changes. The record is read
// the way `pullTasks` would bring it in — the rivetari/tasks branch's copy of
// each task, unless this machine's `.rivetari/tasks/<id>/` holds work the
// branch has never had, or the task is only here — but nothing is fetched,
// no ref moves and nothing under `.rivetari/` is written. Each task's record
// files are copied to a scratch directory and loaded from there, so even the
// ledger.md re-render `loadTask` can do lands outside the repo.
//
// That read costs several git calls a task, which on Windows took a repo with
// 30 tasks more than ten seconds, so a watcher can first list this machine's
// copies read in place (no git, nothing copied) and merge the branch's view in
// after. A running beat's progress file is read every poll on its own, so the
// tab shows a task is alive even while a slow read is under way.
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
import { type Card, TASK_ID } from "./card.js";
import { type Beat, isSeal, type LedgerEntry } from "./ledger.js";
import { readProgress, type TaskProgress } from "./progress.js";
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
/** Tasks read from the branch at once: each read waits on git more than on us. */
const READ_CONCURRENCY = 8;

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
  /** The card as recorded, for a person to read before confirming it. */
  card?: Card | undefined;
  /**
   * assembly.yml as written, once the current card has been routed: what a
   * person reads before approving the route.
   */
  assemblyText?: string | undefined;
  /**
   * The beat running now, from its progress file on this machine; null when
   * none is. Its last activity is the later of the beat's own and the ledger's
   * last write.
   */
  progress?: TaskProgress | null;
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
    card: task.card,
    ...(task.assemblyText === undefined
      ? {}
      : { assemblyText: task.assemblyText }),
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

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** A task's lease.json, or null (said through `onError` when it isn't a lease). */
function leaseOf(
  id: string,
  text: string | null,
  onError: (message: string) => void,
): Lease | null {
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // reported below
  }
  if (isLease(parsed)) return parsed;
  onError(
    `${id}: lease.json isn't a lease (a holder and an expiry); showing no lease`,
  );
  return null;
}

/** `fn` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/**
 * A task's live progress, or null when no beat is running on this machine. The
 * ledger's last write counts as activity too: the beats other than the build
 * only report their start, and each entry they append says they're alive.
 */
async function liveProgress(
  repo: string,
  view: TaskView,
): Promise<TaskProgress | null> {
  if (view.done) return null;
  const progress = await readProgress(repo, view.id);
  if (!progress) return null;
  const wrote = await stat(join(repo, TASKS_DIR, view.id, "ledger.jsonl")).then(
    (s) => s.mtimeMs,
    () => 0,
  );
  return wrote > Date.parse(progress.lastActivityAt) &&
    wrote >= Date.parse(progress.startedAt)
    ? { ...progress, lastActivityAt: new Date(wrote).toISOString() }
    : progress;
}

const withProgress = (repo: string, views: TaskView[]) =>
  Promise.all(
    views.map(async (v) => ({ ...v, progress: await liveProgress(repo, v) })),
  );

/**
 * This machine's copy of every task, read in place: no git, nothing copied and
 * nothing written. The fast first list, before the branch's view is merged in.
 */
async function readLocal(
  repo: string,
  onError: (message: string) => void,
): Promise<TaskView[]> {
  const ids = ((await ifThere(readdir(join(repo, TASKS_DIR)))) ?? [])
    .filter((n) => TASK_ID.test(n))
    .sort(byNumber);
  const views = await Promise.all(
    ids.map(async (id) => {
      const dir = join(repo, TASKS_DIR, id);
      try {
        // A reserved id with no card yet isn't a task to show.
        if (!(await exists(join(dir, "card.yml")))) return null;
        const lease = leaseOf(
          id,
          await ifThere(readFile(join(dir, "lease.json"), "utf8")),
          onError,
        );
        return viewOf(
          await loadTask(repo, id, { readOnly: true }),
          "local",
          lease,
        );
      } catch (err) {
        // The branch read after this one tries it again, and says why if it fails too.
        onError(`${id}: ${(err as Error).message}`);
        return null;
      }
    }),
  );
  return views.filter((v): v is TaskView => v !== null);
}

/**
 * Reads task views, remembering each task's by what it was read from, so a
 * poll only reloads the tasks that moved.
 */
class TaskReader {
  /** Made once, by whichever of the reads running at once gets there first. */
  private scratch: Promise<string> | undefined;
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
    const scratch = await (this.scratch ??= mkdtemp(
      join(tmpdir(), "rivetari-watch-"),
    ));
    const dir = join(scratch, TASKS_DIR, id);
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
    if (!(await exists(join(dir, "card.yml")))) return null;
    const lease = leaseOf(
      id,
      await ifThere(readFile(join(dir, "lease.json"), "utf8")),
      this.onError,
    );
    return viewOf(await loadTask(scratch, id), source, lease);
  }

  /** One task as it stands now: its last view when nothing it's read from moved. */
  private async readOne(
    id: string,
    tip: string | null,
    trees: Map<string, string>,
    local: string[],
  ): Promise<TaskView | null> {
    const stamp = local.includes(id) ? await this.localStamp(id) : null;
    const key = `${tip ? (trees.get(id) ?? "") : ""}|${stamp ?? ""}`;
    const cached = this.seen.get(id);
    if (cached?.key === key) return cached.view;
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
      this.seen.set(id, { key, view });
      this.failed.delete(id);
      return view;
    } catch (err) {
      // Most often a ledger read half-way through an append: keep the last
      // view, don't remember the key, and look again next time. Said once.
      const message = `${id}: ${(err as Error).message}`;
      if (this.failed.get(id) !== message) this.onError(message);
      this.failed.set(id, message);
      return cached?.view ?? null;
    }
  }

  /** Every task as it stands now, oldest first. */
  async read(): Promise<TaskView[]> {
    const tip = await this.tip();
    const trees = await this.branchTrees(tip);
    const local = (
      (await ifThere(readdir(join(this.repo, TASKS_DIR)))) ?? []
    ).filter((n) => TASK_ID.test(n));
    const ids = [...new Set([...trees.keys(), ...local])].sort(byNumber);
    const views = await mapLimit(ids, READ_CONCURRENCY, (id) =>
      this.readOne(id, tip, trees, local),
    );
    for (const id of this.seen.keys())
      if (!ids.includes(id)) this.seen.delete(id);
    return views.filter((v): v is TaskView => v !== null);
  }

  async close(): Promise<void> {
    const scratch = this.scratch;
    this.scratch = undefined;
    this.seen.clear();
    if (scratch) await rm(await scratch, { recursive: true, force: true });
  }
}

/** Every task in `repo` as it stands now, read without writing anything. */
export async function readTasks(
  repo: string,
  onError: (message: string) => void = () => undefined,
): Promise<TaskView[]> {
  const reader = new TaskReader(repo, onError);
  try {
    return await withProgress(repo, await reader.read());
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
 * the branch as well as on disk, and git has no portable change feed. A
 * running beat's progress is polled on its own every `intervalMs` as well,
 * and a change to it alone is a `changed` with no new entries.
 */
export function watchTasks(
  repo: string,
  onEvent: (event: TaskEvent) => void,
  options: {
    intervalMs?: number;
    /** Hears an error `onEvent` threw (default: written to stderr). */
    onListenerError?: (err: unknown) => void;
    /**
     * Snapshot this machine's copies first, read in place, then merge the
     * branch's view in as changes: the list shows at once instead of after a
     * git read of every task.
     */
    localFirst?: boolean;
    /**
     * Hears that a full read (the branch's view merged in) has landed and its
     * events have been emitted, whether or not anything changed: after it, the
     * events are this machine catching up with nothing but what happens next.
     */
    onRead?: () => void;
  } = {},
): TaskWatcher {
  const interval = options.intervalMs ?? WATCH_INTERVAL_MS;
  const listenerFailed =
    options.onListenerError ??
    ((err: unknown) =>
      process.stderr.write(
        `rivetari watch: a listener failed on ${repo}'s tasks: ${err instanceof Error ? err.message : String(err)}\n`,
      ));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;
  let current = new Map<string, TaskView>();
  let snapshotted = false;
  const emit = (event: TaskEvent) => {
    if (stopped) return;
    try {
      onEvent(event);
    } catch (err) {
      // Said, but it mustn't stop the polling or leave `ready` unsettled.
      listenerFailed(err);
    }
  };
  const said = (message: string) => emit({ kind: "error", message });
  const reader = new TaskReader(repo, said);

  let settle: {
    resolve: (t: TaskView[]) => void;
    reject: (e: unknown) => void;
  };
  const ready = new Promise<TaskView[]>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A caller that only listens for events needn't handle a failed first read.
  ready.catch(() => undefined);

  const snapshot = (views: TaskView[]) => {
    snapshotted = true;
    current = new Map(views.map((v) => [v.id, v]));
    settle.resolve(views);
    emit({ kind: "snapshot", tasks: views });
  };

  const changed = (was: TaskView, view: TaskView) => {
    const lastSeq = was.entries.at(-1)?.seq ?? 0;
    emit({
      kind: "changed",
      task: view,
      newEntries: view.entries.filter((e) => e.seq > lastSeq),
      previousBeat: was.beat,
      closed: view.done && !was.done,
    });
  };

  // This machine's copies, before the branch: an error here only costs the
  // head start, since the full read below makes the snapshot instead.
  const first = async () => {
    if (!options.localFirst) return;
    try {
      const views = await withProgress(repo, await readLocal(repo, said));
      if (!stopped) snapshot(views);
    } catch (err) {
      said((err as Error).message);
    }
  };

  const cycle = async () => {
    let views: TaskView[];
    try {
      // Progress is read after the slow part, so it's no older than a poll.
      views = await withProgress(repo, await reader.read());
    } catch (err) {
      said((err as Error).message);
      if (!snapshotted) settle.reject(err);
      return;
    }
    if (stopped) return;
    if (!snapshotted) snapshot(views);
    else {
      const next = new Map(views.map((v) => [v.id, v]));
      for (const view of views) {
        const was = current.get(view.id);
        if (!was) emit({ kind: "added", task: view });
        else if (was !== view && JSON.stringify(was) !== JSON.stringify(view))
          changed(was, view);
      }
      for (const id of current.keys())
        if (!next.has(id)) emit({ kind: "removed", id });
      current = next;
    }
    if (stopped || !options.onRead) return;
    try {
      options.onRead();
    } catch (err) {
      listenerFailed(err);
    }
  };

  // Progress moves every couple of seconds while a beat runs; it's read on
  // its own, so it keeps moving while a slow branch read is under way.
  const pollProgress = async () => {
    if (!snapshotted) return;
    for (const view of [...current.values()]) {
      const progress = await liveProgress(repo, view).catch(() => null);
      const now = current.get(view.id);
      if (stopped) return;
      if (
        !now ||
        JSON.stringify(now.progress ?? null) === JSON.stringify(progress)
      )
        continue;
      const next = { ...now, progress };
      current.set(view.id, next);
      changed(now, next);
    }
  };

  let running: Promise<void> = Promise.resolve();
  let polling: Promise<void> = Promise.resolve();
  const tick = (start = false) => {
    running = (start ? first().then(cycle) : cycle()).finally(() => {
      if (!stopped) timer = setTimeout(tick, interval);
    });
  };
  const tickProgress = () => {
    polling = pollProgress().finally(() => {
      if (!stopped) progressTimer = setTimeout(tickProgress, interval);
    });
  };
  tick(true);
  progressTimer = setTimeout(tickProgress, interval);

  return {
    ready,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (progressTimer) clearTimeout(progressTimer);
      try {
        await Promise.all([running, polling]);
      } finally {
        // Stopped before the first read landed: whoever awaits `ready` hears so.
        if (!snapshotted)
          settle.reject(new Error("the watcher stopped before its first read"));
        await reader.close();
      }
    },
  };
}
