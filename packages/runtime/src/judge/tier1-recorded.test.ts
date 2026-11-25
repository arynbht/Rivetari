// Recorded checks stand in for checks tier 1 can't run (the judge eval
// replays a pilot's runs): they count like checks that ran, and a check that
// does run replaces its recording.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import type { CheckOutcome } from "./outcome.js";
import { runTier1 } from "./tier1.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

async function repo(): Promise<{ path: string; base: string; head: string }> {
  const path = await mkdtemp(join(tmpdir(), "rivetari-t1rec-"));
  dirs.push(path);
  const git = simpleGit(path);
  await git.init(["--quiet"]);
  await git.addConfig("commit.gpgsign", "false");
  await git.addConfig("user.name", "t");
  await git.addConfig("user.email", "t@example.com");
  await writeFile(join(path, "a.txt"), "one\n");
  await git.raw(["add", "-A"]);
  await git.raw(["commit", "--quiet", "-m", "base"]);
  const base = (await git.revparse(["HEAD"])).trim();
  await writeFile(join(path, "a.txt"), "one\ntwo\n");
  await git.raw(["commit", "--quiet", "-am", "head"]);
  return { path, base, head: (await git.revparse(["HEAD"])).trim() };
}

const recorded = (outcome: CheckOutcome["outcome"]): CheckOutcome => ({
  id: "quality.lint.clean",
  title: "Lint passes",
  base: "green",
  head: outcome === "fail" ? "red" : "green",
  outcome,
  message: "recorded",
});

describe("runTier1 with recorded checks", () => {
  it("counts a recorded pass, so a run with no live check still passes", async () => {
    const r = await repo();
    const result = await runTier1({
      repoPath: r.path,
      base: r.base,
      head: r.head,
      checks: [],
      recordedChecks: [recorded("pass")],
      install: false,
    });
    expect(result.verdict).toBe("pass");
    expect(result.checks.find((c) => c.id === "quality.lint.clean")).toEqual(
      recorded("pass"),
    );
    expect(result.notes).toEqual([]);
  });

  it("fails on a recorded failure", async () => {
    const r = await repo();
    const result = await runTier1({
      repoPath: r.path,
      base: r.base,
      head: r.head,
      checks: [],
      recordedChecks: [recorded("fail")],
      install: false,
    });
    expect(result.verdict).toBe("fail");
  });

  it("still fails closed when nothing ran and nothing was recorded", async () => {
    const r = await repo();
    const result = await runTier1({
      repoPath: r.path,
      base: r.base,
      head: r.head,
      checks: [],
      install: false,
    });
    expect(result.verdict).toBe("fail");
    expect(result.notes.join("\n")).toMatch(/nothing was verified/);
  });
});
