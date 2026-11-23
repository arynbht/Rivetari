import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  runTaskClose,
  runTaskConfirm,
  runTaskNew,
  runTaskRelease,
  runTaskResume,
  runTaskRunAll,
  runTaskStatus,
} from "./task.js";

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
  // One ledger key for both "machines": the App holds the shared key later (§8).
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

/** An origin with a rivetari profile, and two people's clones of it. */
async function team(): Promise<{ ann: string; bob: string }> {
  const origin = await tmp("rivetari-origin-");
  git(origin, "init", "--bare", "-b", "main");
  const seed = await tmp("rivetari-seed-");
  git(seed, "init", "-b", "main");
  execFileSync("git", ["-C", seed, "commit", "--allow-empty", "-m", "base"], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
  });
  git(seed, "push", "-q", origin, "main");
  const clone = async (email: string) => {
    const dir = await tmp("rivetari-clone-");
    git(dir, "clone", "-q", origin, ".");
    git(dir, "config", "user.email", email);
    await writeFile(join(dir, ".gitignore"), ".rivetari/tasks/\n");
    return dir;
  };
  return { ann: await clone("ann@team"), bob: await clone("bob@team") };
}

const draft = (path: string) =>
  runTaskNew("Fix the login redirect", {
    type: "fix",
    description: "After login the app lands on a blank page.",
    accept: ["Redirects to /home after login::e2e"],
    path,
  });

describe("rivetari task, shared through the rivetari/tasks branch", () => {
  it("drafts on one machine, and the other sees it but can't take it while it's held", async () => {
    const { ann, bob } = await team();
    expect(await draft(ann), err.join(" | ")).toBe(0);
    expect(out.join("")).toContain("drafted T-0001");

    out = [];
    expect(await runTaskStatus({ path: bob })).toBe(0);
    expect(out.join("")).toMatch(/T-0001\s+draft\s+Fix the login redirect/);

    // Bob's own draft gets the next id, not a second T-0001.
    out = [];
    expect(await draft(bob), err.join(" | ")).toBe(0);
    expect(out.join("")).toContain("drafted T-0002");

    // Ann holds T-0001: Bob is refused before anything is recorded.
    expect(await runTaskConfirm("T-0001", { yes: true, path: bob })).toBe(1);
    expect(err.join("\n")).toMatch(/T-0001 is held by ann@team on /);

    // Once Ann releases it, Bob takes it over and carries on.
    expect(await runTaskRelease("T-0001", { path: ann })).toBe(0);
    expect(await runTaskConfirm("T-0001", { yes: true, path: bob })).toBe(0);
    out = [];
    expect(await runTaskResume("T-0001", { path: ann })).toBe(0);
    expect(out.join("")).toMatch(/intake confirmed.*\(bob@team \(--yes\)\)/);
    expect(out.join("")).toMatch(/held by bob@team on .* until/);
  }, 60_000);

  it("says a beat is done when only the push of its record failed, and exits 1", async () => {
    const { ann } = await team();
    expect(await draft(ann), err.join(" | ")).toBe(0);
    const origin = git(ann, "remote", "get-url", "origin");
    await writeFile(
      join(origin, "hooks", "pre-receive"),
      '#!/bin/sh\nwhile read old new ref; do\n  if git log -1 --format=%s "$new" | grep -q "confirm done$"; then echo refused >&2; exit 1; fi\ndone\nexit 0\n',
      { mode: 0o755 },
    );
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((s) => {
      stderr.push(String(s));
      return true;
    });
    expect(await runTaskConfirm("T-0001", { yes: true, path: ann })).toBe(1);
    expect(stderr.join("")).toContain(
      "rivetari task: confirm is done, but pushing its record failed:",
    );
    expect(stderr.join("")).toContain(
      "the record is kept on this machine; the next `rivetari task` beat on T-0001 pushes it once origin is reachable",
    );
    expect(git(origin, "log", "-1", "--format=%s", "rivetari/tasks")).toBe(
      "T-0001: confirm",
    );
  }, 120_000);

  it("runs --all only when the repo is unattended", async () => {
    const { ann } = await team();
    expect(await runTaskRunAll({ path: ann })).toBe(1);
    expect(err.join("\n")).toContain(
      "run --all needs `autonomy: unattended` in .rivetari/profile.yml (this repo is supervised)",
    );
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(ann, ".rivetari"), { recursive: true });
    await writeFile(
      join(ann, ".rivetari", "profile.yml"),
      "version: 1\nname: demo\ntype: library\nautonomy: unattended\n",
    );
    out = [];
    expect(await runTaskRunAll({ path: ann })).toBe(0);
    expect(out.join("")).toContain("shipped: none");
  }, 60_000);

  it("at review-at-pr, drafts, confirms and routes in one command and says to run next", async () => {
    const { ann } = await team();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(ann, ".rivetari"), { recursive: true });
    await writeFile(
      join(ann, ".rivetari", "profile.yml"),
      "version: 1\nname: demo\ntype: library\nautonomy: review-at-pr\n",
    );
    expect(
      await runTaskNew("Fix total so it sums", {
        type: "fix",
        description: "total() returns 0; it should add up its list.",
        accept: ["total adds up a list::unit"],
        path: ann,
      }),
      err.join(" | "),
    ).toBe(0);
    const text = out.join("");
    expect(text).toContain("drafted T-0001: Fix total so it sums");
    expect(text).toContain(
      "card confirmed without asking (autonomy review-at-pr)",
    );
    expect(text).toContain(
      "route approved without asking (autonomy review-at-pr)",
    );
    expect(text).toContain("next: `rivetari task run T-0001`");
    expect(text).not.toContain("rivetari task confirm");
    out = [];
    expect(await runTaskStatus({ path: ann })).toBe(0);
    expect(out.join("")).toMatch(/T-0001\s+route\s+Fix total so it sums/);
  }, 60_000);

  it("at review-at-pr, stops once at the route with the reason when a sector is borderline", async () => {
    const { ann } = await team();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(ann, ".rivetari"), { recursive: true });
    await writeFile(
      join(ann, ".rivetari", "profile.yml"),
      "version: 1\nname: demo\ntype: library\nautonomy: review-at-pr\n",
    );
    expect(
      await runTaskNew("Fix the login redirect", {
        type: "fix",
        description: "After login the app shows nothing.",
        accept: ["Redirects to /home after login::e2e"],
        touches: ["src/styles/**"],
        path: ann,
      }),
      err.join(" | "),
    ).toBe(0);
    const text = out.join("");
    expect(text).toContain(
      "card confirmed without asking (autonomy review-at-pr)",
    );
    expect(text).toContain(
      "next: route: a person approves this route (borderline sector(s): ui): review assembly.yml, then `rivetari task approve T-0001`",
    );
  }, 60_000);

  it("lists a closed task as closed, even one closed before it was confirmed", async () => {
    const { ann } = await team();
    expect(await draft(ann), err.join(" | ")).toBe(0);
    expect(
      await runTaskClose("T-0001", { abandon: "superseded", path: ann }),
    ).toBe(0);
    out = [];
    expect(await runTaskStatus({ path: ann })).toBe(0);
    expect(out.join("")).toMatch(/T-0001\s+closed\s+Fix the login redirect/);
  }, 60_000);

  it("refuses a card with no verify before reserving an id", async () => {
    const { ann } = await team();
    expect(
      await runTaskNew("No verify", {
        type: "fix",
        description: "d",
        accept: ["works"],
        path: ann,
      }),
    ).toBe(1);
    expect(err.join(" | ")).toMatch(/verify/);
    expect(git(ann, "branch", "--list", "rivetari/tasks")).toBe("");
  }, 60_000);
});
