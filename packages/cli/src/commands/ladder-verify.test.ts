import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ladder, setAutonomy } from "@arynbht/rivetari-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { sessionStartText } from "./hook.js";
import { renderLadder } from "./metrics.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const NOW = new Date("2026-11-21T12:00:00Z");
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function rivetariRepo(): Promise<string> {
  const repo = await tmp("rivetari-ladder-verify-");
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.email", "t@t");
  git(repo, "config", "user.name", "t");
  await mkdir(join(repo, ".rivetari"));
  await writeFile(
    join(repo, ".rivetari", "profile.yml"),
    "version: 1\nname: demo\ntype: library\nautonomy: supervised\n",
  );
  await writeFile(join(repo, "README.md"), "# demo\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "base", "--no-verify");
  return repo;
}

async function raised(repo: string): Promise<void> {
  await setAutonomy(repo, "review-at-pr", {
    by: "owner@example.com",
    override: "rule 6",
    now: NOW,
  });
}

const FAILED = /autonomy ledger .*failed verification/;
const SUPERVISED = /runs supervised/;

describe("a failed autonomy ledger verification, as people see it", () => {
  it("is named, with its problems, in rivetari metrics and the session-start text", async () => {
    const repo = await rivetariRepo();
    await raised(repo);
    const jsonl = join(repo, ".rivetari", "autonomy", "ledger.jsonl");
    await writeFile(
      jsonl,
      (await readFile(jsonl, "utf8")).replace("reason: rule 6", "reason: me"),
    );
    const metrics = renderLadder(await ladder(repo, { now: NOW }));
    const session = await sessionStartText(repo);
    for (const text of [metrics, session]) {
      expect(text).toMatch(FAILED);
      expect(text).toMatch(/- entry 1: contents don't match its seal/);
      expect(text).toMatch(SUPERVISED);
    }
  });

  it("prints none of it for an intact ledger, or for a repo with no ledger yet", async () => {
    const empty = await rivetariRepo();
    const intact = await rivetariRepo();
    await raised(intact);
    for (const repo of [empty, intact]) {
      const metrics = renderLadder(await ladder(repo, { now: NOW }));
      const session = await sessionStartText(repo);
      for (const text of [metrics, session]) {
        expect(text).not.toMatch(FAILED);
        expect(text).not.toMatch(SUPERVISED);
        expect(text).not.toMatch(/contents don't match its seal/);
      }
    }
  });
});
