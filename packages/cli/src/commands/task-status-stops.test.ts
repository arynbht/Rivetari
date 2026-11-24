import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTask } from "@arynbht/rivetari-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runTaskNew, runTaskResume, runTaskStatus } from "./task.js";

// A person answering a stop reads it from `task status` or `task resume`, so
// both show the agent's question whole, however long it is.

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
beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
  out = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

/** A clone of an origin, so the tasks branch has somewhere to live. */
async function clone(): Promise<string> {
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
  const dir = await tmp("rivetari-clone-");
  git(dir, "clone", "-q", origin, ".");
  git(dir, "config", "user.email", "ann@team");
  await writeFile(join(dir, ".gitignore"), ".rivetari/tasks/\n");
  return dir;
}

describe("rivetari task status and resume, on a task waiting on a question", () => {
  it("show the whole question", async () => {
    const repo = await clone();
    expect(
      await runTaskNew("Fix the total", {
        type: "fix",
        description: "total should sum the order lines.",
        accept: ["total sums lines::unit"],
        path: repo,
      }),
    ).toBe(0);
    const question = `Which rounding should total() use? ${"The ledger rounds to cents, the invoice to whole units, and the export keeps four places. ".repeat(8)}Pick one.`;
    expect(question.length).toBeGreaterThan(500);
    const task = await loadTask(repo, "T-0001");
    await task.ledger.append({
      beat: "build",
      section: "stop",
      text: `asked: agent_question: ${question}`,
      by: "rivetari runtime (for ann@team)",
    });

    out = [];
    expect(await runTaskStatus({ path: repo })).toBe(0);
    expect(out.join("")).toContain(
      `T-0001  draft     Fix the total\n  waiting on: agent_question: ${question}\n`,
    );

    out = [];
    expect(await runTaskResume("T-0001", { path: repo })).toBe(0);
    expect(out.join("")).toContain(`asked: agent_question: ${question}`);
  }, 60_000);
});
