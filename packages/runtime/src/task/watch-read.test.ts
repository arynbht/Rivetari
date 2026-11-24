import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { newTask } from "./tasks.js";
import { watchTasks } from "./watch.js";

// The desktop shell tells a person about a new question only once the
// watcher has caught up with the tasks branch, so the watcher says when each
// full read has landed: after the local-first snapshot and its catch-up
// events, never before them.

const BY = "ann@example.com";
let repo = "";
let config = "";
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), "rivetari-config-"));
  process.env.RIVETARI_CONFIG_DIR = config;
  repo = await mkdtemp(join(tmpdir(), "rivetari-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("commit", "-q", "--allow-empty", "-m", "base", "--no-verify");
});

afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  await rm(repo, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

describe("a watcher's full reads", () => {
  it("are told after the local-first snapshot and each later read, and not after it stops", async () => {
    await newTask(
      repo,
      {
        title: "Dark mode",
        type: "feature",
        description: "Readers can switch the theme.",
        acceptance: [{ id: "A1", text: "It switches", verify: "e2e" }],
      },
      { by: BY, id: "T-0001" },
    );
    const heard: string[] = [];
    let reads = 0;
    const watcher = watchTasks(repo, (event) => heard.push(event.kind), {
      intervalMs: 50,
      localFirst: true,
      onRead: () => {
        reads += 1;
        heard.push("read");
      },
    });
    await expect.poll(() => reads, { timeout: 15_000 }).toBeGreaterThan(1);
    await watcher.stop();
    const after = reads;
    expect(heard[0]).toBe("snapshot");
    expect(heard.indexOf("read")).toBeGreaterThan(0);
    await new Promise((r) => setTimeout(r, 200));
    expect(reads).toBe(after);
  });

  it("is told for a watcher with no local-first list too, after its snapshot", async () => {
    const heard: string[] = [];
    const watcher = watchTasks(repo, (event) => heard.push(event.kind), {
      intervalMs: 60_000,
      onRead: () => heard.push("read"),
    });
    await watcher.ready;
    await expect.poll(() => heard).toEqual(["snapshot", "read"]);
    await watcher.stop();
  });
});
