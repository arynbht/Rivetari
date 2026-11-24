// Now adapter: a runtime task watcher on every repo in the sidebar for as long
// as the window is open, so the Now view, the sidebar's badges and the OS
// notifications stay current whichever tab is on show. The repo on show is
// read every couple of seconds, the others less often. Everything here is read
// from the records the watcher hands over (the runtime's own `needsYou`,
// `next`, progress and ledger entries); nothing here writes. The Tasks tab
// still keeps its own watcher (tasks.ts) until it folds into this one.
// Electron-free: the pushes and the notification are callbacks passed in.
import { resolve } from "node:path";

import {
  type Assembly,
  type Card,
  JUDGE_VERDICT,
  type LedgerEntry,
  parseAssembly,
  sha256,
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
import { applyTaskEvent } from "./tasks";

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

function cardOf(card: Card): NowCard {
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

function assemblyOf(a: Assembly): NowAssembly {
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
  /** When the hub started watching: an item from an entry before this was already waiting. */
  since: number;
}

/** Windows paths are case-insensitive: C:\Repo and c:\repo are one repo. */
const keyOf = (path: string) => {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
};

export class NowHub {
  private readonly repos = new Map<string, Watched>();
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
    const wanted = new Map(paths.map((p) => [keyOf(p), p]));
    const gone = [...this.repos.entries()].filter(([k]) => !wanted.has(k));
    for (const [key] of gone) this.repos.delete(key);
    for (const [key, repoPath] of wanted)
      if (!this.repos.has(key)) {
        const entry: Watched = {
          repoPath,
          watcher: null,
          interval: this.intervalFor(key),
          views: [],
          ready: false,
          error: null,
          known: new Set(),
          primed: false,
          since: this.now(),
        };
        this.repos.set(key, entry);
        this.start(entry, true);
      }
    this.badges(true);
    await Promise.all(gone.map(([, entry]) => entry.watcher?.stop()));
  }

  /** The repo on show (or none): it's read more often than the rest. */
  async select(repoPath: string | null): Promise<void> {
    this.shown = repoPath === null ? null : keyOf(repoPath);
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

  /** How many items wait on a person in each repo; told on only when `force` or changed. */
  badges(force = false): NowBadges {
    const badges = [...this.repos.values()].map((e) => ({
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
    await Promise.all(all.map((e) => e.watcher?.stop()));
  }

  private intervalFor(key: string): number {
    return key === this.shown ? this.intervals.shown : this.intervals.others;
  }

  private start(entry: Watched, localFirst: boolean): void {
    const watcher = this.watch(
      entry.repoPath,
      (event) => {
        // A replaced or stopped watcher's late events speak for nobody.
        if (entry.watcher !== watcher || !this.has(entry)) return;
        entry.views = applyTaskEvent(entry.views, event);
        entry.error = event.kind === "error" ? event.message : null;
        if (event.kind === "snapshot") entry.ready = true;
        this.heard(entry);
        this.options.onState(
          nowState(entry.repoPath, entry.views, entry.ready, entry.error),
        );
        this.badges();
      },
      { intervalMs: entry.interval, localFirst },
    );
    entry.watcher = watcher;
    watcher.ready.catch((err: unknown) => {
      if (entry.watcher !== watcher || !this.has(entry)) return;
      entry.error = err instanceof Error ? err.message : String(err);
      entry.ready = true;
      this.options.onState(
        nowState(entry.repoPath, entry.views, entry.ready, entry.error),
      );
    });
  }

  private has(entry: Watched): boolean {
    return this.repos.get(keyOf(entry.repoPath)) === entry;
  }

  /**
   * Tell `onNew` about items it hasn't heard of. The first read only learns
   * what's there; after it, an item is new when the entry that raised it was
   * written since the hub started watching, so a task the branch read adds
   * later, waiting since before, isn't told as new.
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
    for (const item of items) {
      const key = itemKey(item);
      if (entry.known.has(key)) continue;
      entry.known.add(key);
      const raised = entry.views
        .find((v) => v.id === item.id)
        ?.entries.at(-1)?.at;
      if (raised !== undefined && Date.parse(raised) >= entry.since)
        this.options.onNew(entry.repoPath, item);
    }
    for (const key of entry.known) if (!keys.has(key)) entry.known.delete(key);
  }
}
