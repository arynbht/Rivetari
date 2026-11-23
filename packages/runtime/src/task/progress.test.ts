import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PROGRESS_STALE_MS,
  progressPath,
  ProgressWriter,
  readProgress,
  trackBeat,
} from "./progress.js";
import { commitTask, TASKS_BRANCH } from "./store.js";
import { newTask, TASKS_DIR } from "./tasks.js";

let repo = "";
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
  repo = await tmp("rivetari-progress-");
  await mkdir(join(repo, TASKS_DIR, "T-0001"), { recursive: true });
});
afterEach(async () => {
  vi.useRealTimers();
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const onDisk = async () =>
  JSON.parse(await readFile(progressPath(repo, "T-0001"), "utf8")) as Record<
    string,
    unknown
  >;

/** A clock the test moves by hand. */
function clock(start = "2026-11-23T10:00:00.000Z") {
  let t = Date.parse(start);
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("a beat's progress file", () => {
  it("is written at the start, beside the task's directory, never in it", async () => {
    const c = clock();
    const writer = new ProgressWriter(repo, "T-0001", "build", { now: c.now });
    await writer.start();
    expect(progressPath(repo, "T-0001")).toBe(
      join(repo, TASKS_DIR, "T-0001.progress.json"),
    );
    expect(await onDisk()).toEqual({
      beat: "build",
      startedAt: "2026-11-23T10:00:00.000Z",
      lastActivityAt: "2026-11-23T10:00:00.000Z",
      pid: process.pid,
    });
    expect(await readdir(join(repo, TASKS_DIR, "T-0001"))).toEqual([]);
    await writer.finish();
  });

  it("writes at most once a throttle period, and the last update always lands", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const c = clock();
    const writer = new ProgressWriter(repo, "T-0001", "build", {
      now: c.now,
      throttleMs: 2000,
    });
    await writer.start();

    c.advance(500);
    writer.update({ turns: 1, tokens: 100, lastTool: "Read" });
    c.advance(500);
    writer.update({ turns: 2, tokens: 250, lastTool: "Edit" });
    // Inside the throttle: nothing new on disk yet.
    expect((await onDisk()).turns).toBeUndefined();

    c.advance(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () =>
      expect(await onDisk()).toMatchObject({
        turns: 2,
        tokens: 250,
        lastTool: "Edit",
        lastActivityAt: "2026-11-23T10:00:01.000Z",
      }),
    );

    // Past the throttle, an update is written at once.
    c.advance(5000);
    writer.update({ turns: 3, tokens: 400, lastTool: "Bash" });
    await vi.waitFor(async () =>
      expect(await onDisk()).toMatchObject({
        turns: 3,
        lastActivityAt: "2026-11-23T10:00:07.000Z",
      }),
    );
    await writer.finish();
  });

  it("leaves no temp file behind, and is gone when the beat ends, even when it throws", async () => {
    await expect(
      trackBeat(repo, "T-0001", "judge", async (progress) => {
        progress.update();
        expect((await onDisk()).beat).toBe("judge");
        throw new Error("the judge broke");
      }),
    ).rejects.toThrow("the judge broke");
    expect(await readdir(join(repo, TASKS_DIR))).toEqual(["T-0001"]);
  });

  it("is ignored when the process that wrote it is gone, or it's very old", async () => {
    const at = new Date("2026-11-23T10:00:00.000Z");
    const write = (body: object) =>
      writeFile(progressPath(repo, "T-0001"), JSON.stringify(body));
    const base = {
      beat: "build",
      startedAt: at.toISOString(),
      lastActivityAt: at.toISOString(),
    };

    await write({ ...base, pid: 4242 });
    const later = new Date(at.getTime() + 60_000);
    expect(
      await readProgress(repo, "T-0001", { now: later, alive: () => true }),
    ).toMatchObject({ beat: "build", pid: 4242 });
    expect(
      await readProgress(repo, "T-0001", { now: later, alive: () => false }),
    ).toBeNull();
    // A quiet beat whose process is alive is still running (the tab says it's quiet).
    expect(
      await readProgress(repo, "T-0001", {
        now: new Date(at.getTime() + 30 * 60_000),
        alive: () => true,
      }),
    ).not.toBeNull();
    expect(
      await readProgress(repo, "T-0001", {
        now: new Date(at.getTime() + PROGRESS_STALE_MS + 1),
        alive: () => true,
      }),
    ).toBeNull();

    await writeFile(progressPath(repo, "T-0001"), "{ half");
    expect(await readProgress(repo, "T-0001")).toBeNull();
    await write({ beat: "build" });
    expect(await readProgress(repo, "T-0001")).toBeNull();
    await rm(progressPath(repo, "T-0001"));
    expect(await readProgress(repo, "T-0001")).toBeNull();
  });

  it("this process's own file reads as running", async () => {
    await trackBeat(repo, "T-0001", "build", async () => {
      expect(await readProgress(repo, "T-0001")).toMatchObject({
        beat: "build",
        pid: process.pid,
      });
    });
    expect(await readProgress(repo, "T-0001")).toBeNull();
  });
});

describe("the tasks branch", { timeout: 30_000 }, () => {
  it("never gets a running task's progress", async () => {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    git("commit", "-q", "--allow-empty", "-m", "base", "--no-verify");
    await rm(join(repo, TASKS_DIR, "T-0001"), { recursive: true });
    await newTask(
      repo,
      {
        title: "Running task",
        type: "feature",
        description: "A change in flight.",
        acceptance: [{ id: "A1", text: "It works", verify: "unit" }],
      },
      { by: "ann@example.com", id: "T-0001" },
    );
    await trackBeat(repo, "T-0001", "build", async () => {
      await commitTask(repo, "T-0001", {
        holder: "ann@example.com on box",
        message: "T-0001: build",
      });
    });
    const files = git("ls-tree", "-r", "--name-only", TASKS_BRANCH);
    expect(files).toContain("T-0001/ledger.jsonl");
    expect(files).not.toMatch(/progress/);
  });
});
