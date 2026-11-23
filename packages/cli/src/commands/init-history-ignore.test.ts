import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runInit } from "./init.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

describe("runInit and .rivetari/history.jsonl", { timeout: 30_000 }, () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
    vi.restoreAllMocks();
  });
  const tmp = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "rivetari-init-history-"));
    made.push(d);
    return d;
  };

  it("lists history.jsonl in .rivetari/.gitignore beside the other entries", async () => {
    const dir = await tmp();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      await runInit(dir, { type: "cli", yes: true }, { token: null }),
    ).toBe(0);
    const lines = (
      await readFile(join(dir, ".rivetari", ".gitignore"), "utf8")
    ).split("\n");
    for (const entry of [
      "tasks/",
      "ai-usage.log",
      "cache/",
      "history.jsonl",
      "*.bak",
      "*.bak.*",
    ])
      expect(lines).toContain(entry);
  });

  it("keeps a history.jsonl written by close out of git status", async () => {
    const dir = await tmp();
    git(dir, "init", "-b", "main");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(
      await runInit(dir, { type: "cli", yes: true }, { token: null }),
    ).toBe(0);
    await writeFile(
      join(dir, ".rivetari", "history.jsonl"),
      `${JSON.stringify({ kind: "task", task: "T-0001", merged: true })}\n`,
    );

    const status = git(dir, "status", "--porcelain", "--untracked-files=all")
      .split("\n")
      .map((l) => l.trim());
    expect(status.some((l) => l.includes(".rivetari/history.jsonl"))).toBe(
      false,
    );
    expect(() =>
      git(dir, "check-ignore", "-q", ".rivetari/history.jsonl"),
    ).not.toThrow();
    expect(status).toContain("?? .rivetari/profile.yml");
  });
});
