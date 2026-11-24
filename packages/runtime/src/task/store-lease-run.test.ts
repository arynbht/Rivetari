// Two `rivetari task run`s of one task on one machine: the person and the
// machine are the same holder, so while a beat runs the lease also names
// the process running it, and a second process is refused until it ends.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { commitTask, LeaseError, localLease } from "./store.js";

const made: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const c of children) c.kill("SIGKILL");
  children.length = 0;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function repoWithTask(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "rivetari-lease-run-"));
  made.push(repo);
  git(repo, "init", "-q", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  git(repo, "commit", "-q", "--allow-empty", "-m", "base", "--no-verify");
  const dir = join(repo, ".rivetari", "tasks", "T-0001");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "card.yml"), "id: T-0001\n");
  await writeFile(join(dir, "ledger.jsonl"), '{"seq":1}\n');
  return repo;
}

/** Another process on this machine, standing in for the first run. */
function otherRun(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
  children.push(child);
  return new Promise((resolve, reject) => {
    child.once("spawn", () => resolve(child));
    child.once("error", reject);
  });
}

const gone = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  });

const NOW = new Date("2026-11-24T06:29:00Z");
const holder = "ann@team on AB_Rouge";
const run = { holder, message: "T-0001: run", now: NOW };

/** The first run takes the lease as `rivetari task run` does, from `pid`. */
const firstRun = (repo: string, pid: number | undefined) =>
  commitTask(repo, "T-0001", { ...run, pid, running: true });

describe("the lease on one machine", { timeout: 30_000 }, () => {
  it("refuses a second process while the run holding it is alive", async () => {
    const repo = await repoWithTask();
    const first = await otherRun();
    await firstRun(repo, first.pid);
    expect((await localLease(repo, "T-0001"))?.pid).toBe(first.pid);

    const second = commitTask(repo, "T-0001", { ...run, running: true });
    await expect(second).rejects.toBeInstanceOf(LeaseError);
    await expect(second).rejects.toThrow(
      `T-0001 is being run by process ${first.pid} on this machine (${holder}) until 2026-11-24T08:29:00.000Z`,
    );
    // A quick write from another process (an answer, the desktop) waits too.
    await expect(commitTask(repo, "T-0001", run)).rejects.toBeInstanceOf(
      LeaseError,
    );
    // The first run's own heartbeats go on.
    await commitTask(repo, "T-0001", {
      ...run,
      pid: first.pid,
      running: true,
      leaseOnly: true,
    });
  });

  it("lets the next run take it once that process has ended", async () => {
    const repo = await repoWithTask();
    const first = await otherRun();
    await firstRun(repo, first.pid);
    await gone(first);
    await commitTask(repo, "T-0001", { ...run, running: true });
    expect((await localLease(repo, "T-0001"))?.pid).toBe(process.pid);
  });

  it("names no process once the beat's done, so the task is free on this machine", async () => {
    const repo = await repoWithTask();
    const first = await otherRun();
    await firstRun(repo, first.pid);
    // The write that finishes the beat, as `rivetari task` makes it.
    await commitTask(repo, "T-0001", { ...run, pid: first.pid });
    expect((await localLease(repo, "T-0001"))?.pid).toBeUndefined();
    await commitTask(repo, "T-0001", { ...run, running: true });
  });

  it("can still be released from another terminal, and is then free", async () => {
    const repo = await repoWithTask();
    const first = await otherRun();
    await firstRun(repo, first.pid);
    await commitTask(repo, "T-0001", {
      ...run,
      message: "T-0001: released",
      release: true,
    });
    await commitTask(repo, "T-0001", { ...run, running: true });
    expect((await localLease(repo, "T-0001"))?.pid).toBe(process.pid);
  });
});
