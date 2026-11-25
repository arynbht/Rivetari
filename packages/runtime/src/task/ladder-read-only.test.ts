import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ladder, setAutonomy } from "./ladder.js";

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
  const dir = await mkdtemp(join(tmpdir(), "rivetari-ladder-ro-"));
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

const autonomyDir = (dir: string) => join(dir, ".rivetari", "autonomy");

describe("a read-only ladder writes nothing", () => {
  it("leaves a stale ledger.md as it is and still reads review-at-pr", async () => {
    const dir = await repoAtReviewAtPr();
    const md = join(autonomyDir(dir), "ledger.md");
    const stale = (await readFile(md, "utf8")).replace(
      /<!-- Written by .*? -->/,
      "<!-- Written by the factory runtime from ledger.jsonl. Don't edit: changes are detected. -->",
    );
    await writeFile(md, stale);
    const jsonl = await readFile(join(autonomyDir(dir), "ledger.jsonl"));

    const state = await ladder(dir, { now: NOW, readOnly: true });

    expect(await readFile(md, "utf8")).toBe(stale);
    expect(await readFile(join(autonomyDir(dir), "ledger.jsonl"))).toEqual(
      jsonl,
    );
    expect(state.verification).toEqual([]);
    expect(state.effective).toBe("review-at-pr");
  });

  it("still runs supervised when a signed entry was edited", async () => {
    const dir = await repoAtReviewAtPr();
    const jsonl = join(autonomyDir(dir), "ledger.jsonl");
    await writeFile(
      jsonl,
      (await readFile(jsonl, "utf8")).replace("reason: rule 6", "reason: me"),
    );

    const state = await ladder(dir, { now: NOW, readOnly: true });

    expect(state.effective).toBe("supervised");
    expect(state.verification).toEqual([
      expect.stringMatching(/^entry 1: contents don't match its seal/),
    ]);
  });
});
