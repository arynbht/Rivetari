// When the Project view checks profile.yml against the repo again, so it stays
// current without anyone pressing a button: when the repo is opened, after a
// task in it closes as merged (the change most likely to move the stack or the
// phase), and otherwise once a day. A check is held between those, so opening
// the tab or switching back to it reads what's held instead of the disk. The
// Refresh button checks at once. Kept free of electron so it unit-tests with a
// fake clock.
import { resolve } from "node:path";

import type { TaskView } from "@arynbht/rivetari-runtime";

import type { ProjectView } from "../../shared/ipc";
import type { ProjectCheck } from "./project";

/** A check older than this is due again. */
export const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

export interface ProjectChecksOptions {
  check: (repoPath: string) => Promise<ProjectCheck>;
  records: (
    repoPath: string,
    views: TaskView[],
  ) => Promise<Omit<ProjectView, keyof ProjectCheck>>;
  /** The tasks the Now hub last read for a repo, for the route gaps. */
  views: (repoPath: string) => TaskView[];
  /** Hears a repo's view after a check nobody asked for landed. */
  onUpdate: (view: ProjectView) => void;
  /** Hears a check that failed when nobody was waiting on it. */
  onError: (repoPath: string, err: unknown) => void;
  now?: () => number;
}

/** Windows paths are case-insensitive: C:\Repo and c:\repo are one repo. */
const keyOf = (path: string) => {
  const full = resolve(path);
  return process.platform === "win32" ? full.toLowerCase() : full;
};

export class ProjectChecks {
  private readonly held = new Map<
    string,
    { check: ProjectCheck; at: number }
  >();
  private readonly running = new Map<string, Promise<ProjectCheck>>();
  /** How many times each repo was forgotten, so a late check knows. */
  private readonly forgets = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly options: ProjectChecksOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The repo's view: the held check while it's fresh, else a new one. */
  async view(repoPath: string, force = false): Promise<ProjectView> {
    const held = this.held.get(keyOf(repoPath));
    const check =
      !force && held && this.now() - held.at < CHECK_EVERY_MS
        ? held.check
        : await this.run(repoPath);
    return this.withRecords(check);
  }

  /** The repo was opened, or a task in it merged: check it now and say so. */
  recheck(repoPath: string): void {
    this.run(repoPath)
      .then((check) => this.withRecords(check))
      .then(this.options.onUpdate, (err: unknown) =>
        this.options.onError(repoPath, err),
      );
  }

  /** Check again every held repo whose check is a day old; call it hourly. */
  due(): void {
    for (const { check, at } of [...this.held.values()])
      if (this.now() - at >= CHECK_EVERY_MS) this.recheck(check.repoPath);
  }

  /** A repo left the sidebar: nothing more to keep current for it. */
  forget(repoPath: string): void {
    const key = keyOf(repoPath);
    this.held.delete(key);
    // A check already running for it mustn't hold it again when it lands.
    this.forgets.set(key, (this.forgets.get(key) ?? 0) + 1);
  }

  /** One check per repo at a time: a second ask waits on the first. */
  private run(repoPath: string): Promise<ProjectCheck> {
    const key = keyOf(repoPath);
    const running = this.running.get(key);
    if (running) return running;
    const started = this.now();
    const forgotten = this.forgets.get(key) ?? 0;
    const next = this.options
      .check(repoPath)
      .then((check) => {
        if ((this.forgets.get(key) ?? 0) === forgotten)
          this.held.set(key, { check, at: started });
        return check;
      })
      .finally(() => {
        if (this.running.get(key) === next) this.running.delete(key);
      });
    this.running.set(key, next);
    return next;
  }

  private async withRecords(check: ProjectCheck): Promise<ProjectView> {
    const records = await this.options.records(
      check.repoPath,
      this.options.views(check.repoPath),
    );
    return { ...check, ...records };
  }
}
