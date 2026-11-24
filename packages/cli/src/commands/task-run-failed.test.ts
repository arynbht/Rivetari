import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runTaskApprove,
  runTaskConfirm,
  runTaskNew,
  runTaskRoute,
  runTaskRun,
} from "./task.js";

// `rivetari task run` ending on a beat that threw exits 1 with a summary
// line, so whatever launched it never reads the failure as a quiet stop.

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
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
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

describe("rivetari task run, when a beat throws", () => {
  it("exits 1 and says which beat failed and why, then what's next", async () => {
    const dir = await clone();
    expect(
      await runTaskNew("Fix the total", {
        type: "fix",
        description: "total should sum the order lines.",
        accept: ["total sums lines::unit"],
        path: dir,
      }),
      err.join(" | "),
    ).toBe(0);
    expect(
      await runTaskConfirm("T-0001", { yes: true, path: dir }),
      err.join(" | "),
    ).toBe(0);
    expect(await runTaskRoute("T-0001", { path: dir }), err.join(" | ")).toBe(
      0,
    );
    expect(
      await runTaskApprove("T-0001", { yes: true, path: dir }),
      err.join(" | "),
    ).toBe(0);
    // The branch isolate would create is already there, so git refuses the
    // worktree: an error from git itself, not one of Rivetari's own.
    git(dir, "branch", "fix/t-0001");
    out = [];

    expect(await runTaskRun("T-0001", { path: dir })).toBe(1);
    const text = out.join("");
    expect(text).toMatch(/failed: T-0001 failed at isolate: .*fix\/t-0001/);
    expect(text).toContain("next: isolate: `rivetari task isolate T-0001`");
  }, 90_000);
});
