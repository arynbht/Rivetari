import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runTaskNew, runTaskRunAll, runTaskRunParallel } from "./task.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let out: string[];
let err: string[];
beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((s: unknown) => {
    err.push(String(s));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

/** A clone of an origin that has one commit on main. */
async function clone(): Promise<string> {
  const origin = await tmp("rivetari-origin-");
  git(origin, "init", "--bare", "-b", "main");
  const dir = await tmp("rivetari-clone-");
  git(dir, "clone", "-q", origin, ".");
  git(dir, "config", "user.email", "ann@team");
  git(dir, "config", "user.name", "ann");
  git(dir, "commit", "-q", "--allow-empty", "-m", "base");
  git(dir, "push", "-q", "origin", "main");
  await writeFile(join(dir, ".gitignore"), ".rivetari/tasks/\n");
  return dir;
}

/** A second person's clone of the same origin. */
async function cloneOf(first: string, email: string): Promise<string> {
  const dir = await tmp("rivetari-clone-");
  git(dir, "clone", "-q", git(first, "remote", "get-url", "origin"), ".");
  git(dir, "config", "user.email", email);
  await writeFile(join(dir, ".gitignore"), ".rivetari/tasks/\n");
  return dir;
}

describe("rivetari task run --parallel", () => {
  it("refuses a --parallel that isn't a whole number from 1", async () => {
    const dir = await clone();
    for (const parallel of [0, -1, 1.5, Number.NaN])
      expect(await runTaskRunParallel([], { parallel, path: dir })).toBe(1);
    expect(await runTaskRunAll({ parallel: 0, path: dir })).toBe(1);
    expect(err.join("\n")).toContain(
      "--parallel takes a whole number of tasks, 1 or more",
    );
  }, 60_000);

  it("with no ids, runs only confirmed, route-approved tasks, and says when there are none", async () => {
    const dir = await clone();
    // Supervised: the draft waits on a person's confirm, so it isn't picked.
    expect(
      await runTaskNew("Fix the login redirect", {
        type: "fix",
        description: "After login the app lands on a blank page.",
        accept: ["Redirects to /home after login::e2e"],
        path: dir,
      }),
      err.join(" | "),
    ).toBe(0);
    out = [];
    expect(await runTaskRunParallel([], { parallel: 2, path: dir })).toBe(0);
    expect(out.join("")).toContain(
      "nothing to run: no confirmed, route-approved task is waiting on isolate, build, prove, judge or ship",
    );
  }, 60_000);

  it("runs named tasks and sums them up per task, exiting 1 when one errored", async () => {
    const dir = await clone();
    expect(
      await runTaskNew("Fix the login redirect", {
        type: "fix",
        description: "After login the app lands on a blank page.",
        accept: ["Redirects to /home after login::e2e"],
        touches: ["src/login.ts"],
        path: dir,
      }),
      err.join(" | "),
    ).toBe(0);
    out = [];
    // An unconfirmed card under supervised autonomy: run refuses it, as a
    // single run does, and that task's error is in the summary.
    expect(
      await runTaskRunParallel(["T-0001"], { parallel: 2, path: dir }),
    ).toBe(1);
    const text = out.join("");
    expect(text).toContain("T-0001 started\n");
    expect(text).toContain(
      "summary:\n  T-0001 failed: task T-0001 needs a person first",
    );
  }, 60_000);

  it("is refused a task someone else holds, before it runs, as a single run is", async () => {
    const ann = await clone();
    expect(
      await runTaskNew("Fix the login redirect", {
        type: "fix",
        description: "After login the app lands on a blank page.",
        accept: ["Redirects to /home after login::e2e"],
        touches: ["src/login.ts"],
        path: ann,
      }),
      err.join(" | "),
    ).toBe(0);
    const bob = await cloneOf(ann, "bob@team");
    out = [];
    expect(
      await runTaskRunParallel(["T-0001"], { parallel: 2, path: bob }),
    ).toBe(1);
    expect(out.join("")).toMatch(
      /summary:\n {2}T-0001 failed: T-0001 is held by ann@team on /,
    );
    // Ann still holds it: nothing of Bob's reached the branch.
    const origin = git(ann, "remote", "get-url", "origin");
    expect(git(origin, "log", "-1", "--format=%s", "rivetari/tasks")).toBe(
      "T-0001: drafted",
    );
  }, 60_000);
});
