// Now adapter: a runtime task watcher on every repo in the sidebar for as long
// as the window is open, so the Now view, the Tasks tab, the sidebar's badges
// and the OS notifications stay current whichever tab is on show. The repo on
// show is read every couple of seconds, the others less often; the Tasks tab
// listens to the same watcher (tasks.ts), so no repo is polled twice.
// Everything here is read from the records the watcher hands over (the
// runtime's own `needsYou`, `next`, progress and ledger entries); nothing here
// writes. Electron-free: the pushes and the notification are callbacks passed in.
import { resolve } from "node:path";

import {
  type Assembly,
  type Card,
  JUDGE_VERDICT,
  type LedgerEntry,
  parseAssembly,
  sha256,
  type TaskEvent,
  type TaskView,
  type TaskWatcher,
  watchTasks,
} from "@arynbht/rivetari-runtime";

import type {
  NeedsYouItem,
  NowAssembly,
  NowBadges,
  NowCard,
  NowRunning,
  NowState,
  RecentEvent,
  RecentKind,
} from "../../shared/ipc";

/** The list after one watcher event; a read error leaves the list as it was. */
export function applyTaskEvent(
  tasks: TaskView[],
  event: TaskEvent,
): TaskView[] {
  switch (event.kind) {
    case "snapshot":
      return event.tasks;
    case "added":
      return [...tasks, event.task].sort(
        (a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)),
      );
    case "changed":
      return tasks.map((t) => (t.id === event.task.id ? event.task : t));
    case "removed":
      return tasks.filter((t) => t.id !== event.id);
    case "error":
      return tasks;
  }
}

/** The beats whose live progress shows under Running. */
const RUNNING_BEATS = new Set(["build", "prove", "judge", "ship"]);
/** How many ledger events the Recent feed keeps. */
export const RECENT_LIMIT = 50;

const SHIPPED = /^draft PR (?:opened|updated): #\d+/;
const ASKED = /^asked: /;
const ANSWERED = /^answered: (?:allowed|denied)/;
const PROPOSED = /^assembly proposed; /;

/** What the person is shown of a card, and the digest a confirm is checked against. */
export const cardDigest = (card: Card) => sha256(JSON.stringify(card));

export function cardOf(card: Card): NowCard {
  return {
    type: card.type,
    risk: card.risk,
    description: card.description,
    acceptance: card.acceptance.map((a) => ({
      id: a.id,
      text: a.text,
      verify: a.verify,
    })),
    outOfScope: card.out_of_scope,
    touches: card.touches,
  };
}

export function assemblyOf(a: Assembly): NowAssembly {
  return {
    sectors: a.sectors,
    skills: a.skills,
    spine: a.spine,
    gaps: a.gaps,
    checks: a.checks,
    proof: a.proof,
    budget: {
      skillTokens: a.budget.skill_tokens,
      contextTokens: a.budget.context_tokens,
      steps: a.budget.steps,
    },
    stopAndAsk: a.stop_and_ask.map((s) =>
      typeof s === "string" ? s : `touches ${s.touches.join(", ")}`,
    ),
    review: { designPass: a.review.design_pass, security: a.review.security },
  };
}

/**
 * Why the router proposed what it did: the route beat's decision entries,
 * written just before the latest proposal.
 */
export function routeReasons(entries: LedgerEntry[]): string[] {
  const last = entries.findLastIndex(
    (e) =>
      e.beat === "route" && e.section === "timeline" && PROPOSED.test(e.text),
  );
  const reasons: string[] = [];
  for (let i = last - 1; i >= 0; i--) {
    const e = entries[i];
    if (!e || e.beat !== "route" || e.section !== "decision") break;
    reasons.unshift(e.text);
  }
  return reasons;
}

/**
 * Everything in `views` that waits on a person, oldest task first: the
 * runtime's own `needsYou` for each, plus a shipped task whose PR waits for a
 * person to merge it (shipped, not closed: the runtime's next step is the
 * close that follows the merge).
 */
export function needsYouItems(views: TaskView[]): NeedsYouItem[] {
  return views.flatMap((v): NeedsYouItem[] => {
    if (v.done) return [];
    const base = {
      id: v.id,
      title: v.title,
      why: v.needsYou?.why ?? "",
      next: v.next,
      pr: v.pr,
      ledgerSeq: v.entries.at(-1)?.seq ?? 0,
    };
    switch (v.needsYou?.kind) {
      case "intake":
        return v.card
          ? [
              {
                ...base,
                kind: "intake",
                card: cardOf(v.card),
                shown: cardDigest(v.card),
              },
            ]
          : [
              {
                ...base,
                kind: "record",
                why: "the card couldn't be read from the record",
              },
            ];
      case "route": {
        const text = v.assemblyText ?? "";
        const { assembly, problems } = parseAssembly(text);
        return [
          {
            ...base,
            kind: "route",
            assembly: assembly ? assemblyOf(assembly) : null,
            problems,
            reasons: routeReasons(v.entries),
            shown: sha256(text),
          },
        ];
      }
      case "stop":
      case "judge":
      case "record":
        return [{ ...base, kind: v.needsYou.kind }];
      case undefined:
        return v.beat === "ship" && v.pr
          ? [
              {
                ...base,
                kind: "merge",
                why: `shipped as PR #${v.pr.number}; it waits for a person to merge it`,
              },
            ]
          : [];
    }
  });
}

/** Tasks with a build, prove, judge or ship beat running on this machine. */
export function runningTasks(views: TaskView[]): NowRunning[] {
  return views.flatMap((v) =>
    !v.done && v.progress && RUNNING_BEATS.has(v.progress.beat)
      ? [
          {
            id: v.id,
            title: v.title,
            beat: v.progress.beat,
            startedAt: v.progress.startedAt,
            lastActivityAt: v.progress.lastActivityAt,
            ...(v.progress.turns === undefined
              ? {}
              : { turns: v.progress.turns }),
            ...(v.progress.lastTool === undefined
              ? {}
              : { lastTool: v.progress.lastTool }),
            costUsd: v.costUsd,
          },
        ]
      : [],
  );
}

/** Which feed event a ledger entry is, if it's one the feed shows. */
export function recentKind(e: LedgerEntry): RecentKind | null {
  if (e.beat === "close" && e.section === "outcome")
    return e.text.startsWith("abandoned")
      ? "abandoned"
      : /^PR #\d+ merged/.test(e.text)
        ? "merged"
        : "closed";
  if (e.section === "stop")
    return ASKED.test(e.text)
      ? "stopped"
      : ANSWERED.test(e.text)
        ? "answered"
        : null;
  if (e.section !== "timeline") return null;
  if (e.beat === "judge" && JUDGE_VERDICT.test(e.text)) return "judged";
  if (e.beat === "ship" && SHIPPED.test(e.text)) return "shipped";
  return null;
}

/** The feed: those entries across every task, newest first. */
export function recentEvents(
  views: TaskView[],
  limit = RECENT_LIMIT,
): RecentEvent[] {
  return views
    .flatMap((v) =>
      v.entries.flatMap((e) => {
        const kind = recentKind(e);
        return kind
          ? [
              {
                id: v.id,
                title: v.title,
                seq: e.seq,
                at: e.at,
                kind,
                text: e.text,
                by: e.by,
              },
            ]
          : [];
      }),
    )
    .sort((a, b) =>
      a.at === b.at
        ? a.id === b.id
          ? b.seq - a.seq
          : b.id.localeCompare(a.id)
        : b.at.localeCompare(a.at),
    )
    .slice(0, limit);
}

export function nowState(
  repoPath: string,
  views: TaskView[],
  ready: boolean,
  error: string | null,
): NowState {
  return {
    repoPath,
    ready,
    taskCount: views.length,
    running: runningTasks(views),
    needsYou: needsYouItems(views),
    recent: recentEvents(views),
    openCostUsd: views
      .filter((v) => !v.done)
      .reduce((sum, v) => sum + v.costUsd, 0),
    error,
  };
}

/** One item as the notifications tell it apart: a new question is a new item. */
export const itemKey = (item: NeedsYouItem) =>
  `${item.id}#${item.kind}#${item.why}`;

export interface NowHubOptions {
  /** Hears each repo's state after every change. */
  onState: (state: NowState) => void;
  /** Hears the per-repo counts of items waiting, when one changes. */
  onBadges: (badges: NowBadges) => void;
  /**
   * Hears an item that entered Needs you while the app was running: never one
   * that was already waiting when the repo was first read.
   */
  onNew: (repoPath: string, item: NeedsYouItem) => void;
  /**
   * Hears an item (by `itemKey`) that left Needs you, or whose repo left the
   * sidebar: whatever was raised for it has nothing left to point at.
   */
  onGone?: (repoPath: string, key: string) => void;
  /** How often the repo on show is read, and every other one. */
  intervals?: { shown: number; others: number };
  watch?: typeof watchTasks;
  now?: () => number;
}

interface Watched {
  repoPath: string;
  watcher: TaskWatcher | null;
  interval: number;
  views: TaskView[];
  ready: boolean;
  error: string | null;
  /** Items already heard of, so each is told once. */
  known: Set<string>;
  primed: boolean;
  /**
   * The watcher's first full read has landed: the branch's view is merged
   * into the local-first list, and what comes after is news, not catching up.
   */
  caughtUp: boolean;
  /** Each task's last ledger seq once caught up, the mark a new item is judged by. */
  primedSeq: Map<string, number>;
  /** When the hub started watching, for what arrives before it caught up. */
  since: number;
  /** Settles once the first read lands, or once the repo stops being watched. */
  firstRead: Promise<void>;
  read: () => void;
}

/** The Tasks tab: the one repo it shows, told of every change to it. */
interface TabListener {
  key: string;
  repoPath: string;
  onChange: (views: TaskView[], error: string | null) => void;
}

/** Windows paths are case-insensitive: C:\Repo and c:\repo are one repo. */
const keyOf = (path: string) => {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
};

export class NowHub {
  private readonly repos = new Map<string, Watched>();
  private sidebar: string[] = [];
  /** The sidebar's repos: only theirs get badges and notifications. */
  private sidebarKeys = new Set<string>();
  private tab: TabListener | null = null;
  private shown: string | null = null;
  private lastBadges = "";
  private readonly intervals: { shown: number; others: number };
  private readonly watch: typeof watchTasks;
  private readonly now: () => number;

  constructor(private readonly options: NowHubOptions) {
    this.intervals = options.intervals ?? { shown: 2000, others: 10_000 };
    this.watch = options.watch ?? watchTasks;
    this.now = options.now ?? Date.now;
  }

  /** Watch exactly these repos: new ones start, ones no longer listed stop. */
  async setRepos(paths: string[]): Promise<void> {
    const before = this.sidebarKeys;
    this.sidebar = paths;
    this.sidebarKeys = new Set(paths.map(keyOf));
    // A repo off the sidebar that the Tasks tab keeps watched isn't dropped
    // by sync, so what was raised for it is withdrawn here.
    for (const [key, entry] of this.repos)
      if (
        before.has(key) &&
        !this.sidebarKeys.has(key) &&
        this.tab?.key === key
      )
        for (const item of entry.known)
          this.options.onGone?.(entry.repoPath, item);
    await this.sync();
  }

  /** The repo on show (or none): it's read more often than the rest. */
  async select(repoPath: string | null): Promise<void> {
    this.shown = repoPath === null ? null : keyOf(repoPath);
    await this.retune();
  }

  /**
   * Tell `onChange` of every change to `repoPath`'s tasks, for the Tasks tab,
   * replacing whichever repo it was told of before. The repo is watched (and
   * read as often as the one on show) even when it isn't in the sidebar.
   * Resolves with the tasks once the first read has landed.
   */
  async watchTab(
    repoPath: string,
    onChange: TabListener["onChange"],
  ): Promise<{ views: TaskView[]; error: string | null }> {
    const key = keyOf(repoPath);
    this.tab = { key, repoPath, onChange };
    await this.sync();
    await this.retune();
    const entry = this.repos.get(key);
    if (entry) await entry.firstRead;
    return { views: entry?.views ?? [], error: entry?.error ?? null };
  }

  /** The Tasks tab is gone: a repo it alone kept watched stops. */
  async unwatchTab(): Promise<void> {
    this.tab = null;
    await this.sync();
    await this.retune();
  }

  /** The tasks the Tasks tab was last told of, when it shows `repoPath`. */
  tabViews(repoPath: string): TaskView[] | undefined {
    const tab = this.tab;
    if (!tab || tab.key !== keyOf(repoPath)) return undefined;
    return this.repos.get(tab.key)?.views;
  }

  state(repoPath: string): NowState {
    const entry = this.repos.get(keyOf(repoPath));
    return entry
      ? nowState(entry.repoPath, entry.views, entry.ready, entry.error)
      : nowState(repoPath, [], false, null);
  }

  /** The views the hub last read for `repoPath`, for actions that go by the record. */
  views(repoPath: string): TaskView[] {
    return this.repos.get(keyOf(repoPath))?.views ?? [];
  }

  /**
   * How many items wait on a person in each sidebar repo; told on only when
   * `force` or changed. A repo only the Tasks tab keeps watched has no badge.
   */
  badges(force = false): NowBadges {
    const badges = [...this.repos.entries()]
      .filter(([key]) => this.sidebarKeys.has(key))
      .map(([, e]) => ({
        repoPath: e.repoPath,
        count: needsYouItems(e.views).length,
      }));
    const said = JSON.stringify(badges);
    if (force || said !== this.lastBadges) {
      this.lastBadges = said;
      this.options.onBadges(badges);
    }
    return badges;
  }

  async stop(): Promise<void> {
    const all = [...this.repos.values()];
    this.repos.clear();
    this.tab = null;
    for (const entry of all) entry.read();
    await Promise.all(all.map((e) => e.watcher?.stop()));
  }

  /** Watch the sidebar's repos and the Tasks tab's: start the new, stop the rest. */
  private async sync(): Promise<void> {
    const wanted = new Map(this.sidebar.map((p) => [keyOf(p), p]));
    if (this.tab && !wanted.has(this.tab.key))
      wanted.set(this.tab.key, this.tab.repoPath);
    const gone = [...this.repos.entries()].filter(([k]) => !wanted.has(k));
    for (const [key, entry] of gone) {
      this.repos.delete(key);
      entry.read();
      for (const item of entry.known)
        this.options.onGone?.(entry.repoPath, item);
    }
    for (const [key, repoPath] of wanted)
      if (!this.repos.has(key)) {
        let read = () => undefined as void;
        const firstRead = new Promise<void>((r) => (read = r));
        const entry: Watched = {
          repoPath,
          watcher: null,
          interval: this.intervalFor(key),
          views: [],
          ready: false,
          error: null,
          known: new Set(),
          primed: false,
          caughtUp: false,
          primedSeq: new Map(),
          since: this.now(),
          firstRead,
          read,
        };
        this.repos.set(key, entry);
        this.start(entry, true);
      }
    this.badges(true);
    await Promise.all(gone.map(([, entry]) => entry.watcher?.stop()));
  }

  /** Restart any watcher whose repo is now read more or less often. */
  private async retune(): Promise<void> {
    const restarts: Promise<void>[] = [];
    for (const [key, entry] of this.repos) {
      const interval = this.intervalFor(key);
      if (interval === entry.interval) continue;
      entry.interval = interval;
      const old = entry.watcher;
      // The views in hand stay on show; the new watcher's first full read
      // replaces them, with no head start that could drop the branch's tasks.
      this.start(entry, false);
      if (old) restarts.push(old.stop());
    }
    await Promise.all(restarts);
  }

  private intervalFor(key: string): number {
    return key === this.shown || key === this.tab?.key
      ? this.intervals.shown
      : this.intervals.others;
  }

  private start(entry: Watched, localFirst: boolean): void {
    const watcher = this.watch(
      entry.repoPath,
      (event) => {
        // A replaced or stopped watcher's late events speak for nobody.
        if (entry.watcher !== watcher || !this.has(entry)) return;
        entry.views = applyTaskEvent(entry.views, event);
        entry.error = event.kind === "error" ? event.message : null;
        if (event.kind === "snapshot") {
          entry.ready = true;
          entry.read();
        }
        this.heard(entry);
        this.told(entry);
        this.badges();
      },
      {
        intervalMs: entry.interval,
        localFirst,
        onRead: () => {
          if (entry.watcher === watcher && this.has(entry))
            this.caughtUp(entry);
        },
      },
    );
    entry.watcher = watcher;
    watcher.ready.catch((err: unknown) => {
      if (entry.watcher !== watcher || !this.has(entry)) return;
      entry.error = err instanceof Error ? err.message : String(err);
      entry.ready = true;
      entry.read();
      this.told(entry);
    });
  }

  /** Push the repo's state to the Now view, and to the Tasks tab when it shows it. */
  private told(entry: Watched): void {
    this.options.onState(
      nowState(entry.repoPath, entry.views, entry.ready, entry.error),
    );
    if (this.tab?.key === keyOf(entry.repoPath))
      this.tab.onChange(entry.views, entry.error);
  }

  private has(entry: Watched): boolean {
    return this.repos.get(keyOf(entry.repoPath)) === entry;
  }

  /** The first full read landed: each task's seq from here is the mark. */
  private caughtUp(entry: Watched): void {
    if (entry.caughtUp) return;
    entry.caughtUp = true;
    entry.primedSeq = new Map(
      entry.views.map((v) => [v.id, v.entries.at(-1)?.seq ?? 0]),
    );
  }

  /**
   * Tell `onNew` about items it hasn't heard of, for a sidebar repo, and
   * `onGone` about every one that went, wherever its repo is now: one raised
   * while the repo was in the sidebar still has its notice out. The first
   * read only learns what's there; isNew judges after it.
   */
  private heard(entry: Watched): void {
    if (!entry.ready) return;
    const items = needsYouItems(entry.views);
    const keys = new Set(items.map(itemKey));
    if (!entry.primed) {
      entry.known = keys;
      entry.primed = true;
      return;
    }
    const tells = this.sidebarKeys.has(keyOf(entry.repoPath));
    for (const item of items) {
      const key = itemKey(item);
      if (entry.known.has(key)) continue;
      entry.known.add(key);
      if (tells && this.isNew(entry, item))
        this.options.onNew(entry.repoPath, item);
    }
    for (const key of entry.known)
      if (!keys.has(key)) {
        entry.known.delete(key);
        this.options.onGone?.(entry.repoPath, key);
      }
  }

  /**
   * Whether an item raised since the first read is news. Once the watcher's
   * first full read has landed, a task it had is news when its ledger moves
   * past the seq it had then: the ledger's own order, whichever machine's
   * clock wrote the entry. Before that (a local-first list catching up with
   * the branch), and for a task the full read didn't have, there's no seq to
   * go by, so the entry's time is held against when the hub started: one
   * waiting since before isn't told as new.
   */
  private isNew(entry: Watched, item: NeedsYouItem): boolean {
    const seen = entry.caughtUp ? entry.primedSeq.get(item.id) : undefined;
    if (seen !== undefined) return item.ledgerSeq > seen;
    const raised = entry.views
      .find((v) => v.id === item.id)
      ?.entries.at(-1)?.at;
    return raised !== undefined && Date.parse(raised) >= entry.since;
  }
}
