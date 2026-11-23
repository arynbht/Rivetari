import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  autonomyLedger,
  enforceFallback,
  ladder,
  setAutonomy,
} from "./ladder.js";
import { render } from "./ledger.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const savedKey = process.env.RIVETARI_LEDGER_KEY;
const NOW = new Date("2026-11-21T12:00:00Z");
const by = "owner@example.com";

beforeEach(async () => {
  const config = await mkdtemp(join(tmpdir(), "rivetari-config-"));
  made.push(config);
  process.env.RIVETARI_CONFIG_DIR = config;
  delete process.env.RIVETARI_LEDGER_KEY;
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  if (savedKey === undefined) delete process.env.RIVETARI_LEDGER_KEY;
  else process.env.RIVETARI_LEDGER_KEY = savedKey;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repoAtReviewAtPr(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-ladder-verify-"));
  made.push(dir);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await mkdir(join(dir, ".rivetari"), { recursive: true });
  await writeFile(
    join(dir, ".rivetari", "profile.yml"),
    "version: 1\nname: demo\ntype: library\nautonomy: supervised\n",
  );
  await writeFile(join(dir, "README.md"), "# demo\n");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  await setAutonomy(dir, "review-at-pr", {
    by,
    override: "rule 6",
    now: NOW,
  });
  return dir;
}

const jsonlPath = (dir: string) =>
  join(dir, ".rivetari", "autonomy", "ledger.jsonl");
const mdPath = (dir: string) => join(dir, ".rivetari", "autonomy", "ledger.md");

describe("the trust ladder verifies the autonomy ledger", () => {
  it("runs supervised when a signed entry was edited, and names the entry", async () => {
    const dir = await repoAtReviewAtPr();
    const jsonl = jsonlPath(dir);
    await writeFile(
      jsonl,
      (await readFile(jsonl, "utf8")).replace("reason: rule 6", "reason: me"),
    );
    const state = await ladder(dir, { now: NOW });
    expect(state.configured).toBe("review-at-pr");
    expect(state.effective).toBe("supervised");
    expect(state.verification).toEqual([
      expect.stringMatching(/^entry 1: contents don't match its seal/),
    ]);
    expect(state.fallback).toMatch(/autonomy ledger failed verification/);
  });

  it("re-renders a view whose header names the factory runtime, then stays at review-at-pr", async () => {
    const dir = await repoAtReviewAtPr();
    const md = mdPath(dir);
    const fresh = await readFile(md, "utf8");
    await writeFile(
      md,
      fresh.replace(
        /<!-- Written by .*? -->/,
        "<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->",
      ),
    );
    expect(await readFile(md, "utf8")).not.toBe(fresh);
    const state = await ladder(dir, { now: NOW });
    expect(await readFile(md, "utf8")).toBe(fresh);
    const ledger = await autonomyLedger(dir);
    expect(await readFile(md, "utf8")).toBe(
      render("Autonomy", await ledger.entries()),
    );
    expect((await ledger.verify()).ok).toBe(true);
    expect(state.verification).toEqual([]);
    expect(state.effective).toBe("review-at-pr");
  });

  it("treats a ledger.jsonl line that isn't JSON as failed verification, and appends nothing", async () => {
    const dir = await repoAtReviewAtPr();
    const jsonl = jsonlPath(dir);
    await writeFile(jsonl, `${await readFile(jsonl, "utf8")}not json\n`);
    const before = await readFile(jsonl, "utf8");
    const state = await ladder(dir, { now: NOW });
    expect(state.effective).toBe("supervised");
    expect(state.verification).toEqual([
      "ledger.jsonl is not valid JSON lines",
    ]);
    const after = await enforceFallback(dir, {
      by: "rivetari runtime",
      now: NOW,
    });
    expect(after.effective).toBe("supervised");
    expect(await readFile(jsonl, "utf8")).toBe(before);
  });

  it("treats a ledger key that can't be read as failed verification, and appends nothing", async () => {
    const dir = await repoAtReviewAtPr();
    const jsonl = jsonlPath(dir);
    const before = await readFile(jsonl, "utf8");
    process.env.RIVETARI_LEDGER_KEY = "not-a-key";
    const state = await ladder(dir, { now: NOW });
    expect(state.configured).toBe("review-at-pr");
    expect(state.effective).toBe("supervised");
    expect(state.verification).toEqual([
      expect.stringMatching(/ledger key can't be read: RIVETARI_LEDGER_KEY/),
    ]);
    const after = await enforceFallback(dir, {
      by: "rivetari runtime",
      now: NOW,
    });
    expect(after.effective).toBe("supervised");
    expect(await readFile(jsonl, "utf8")).toBe(before);
  });

  it("adds no verification problems for an intact ledger", async () => {
    const dir = await repoAtReviewAtPr();
    const state = await ladder(dir, { now: NOW });
    expect(state.verification).toEqual([]);
    expect(state.effective).toBe("review-at-pr");
    expect(state.fallback).toBeNull();
  });
});
