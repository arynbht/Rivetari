import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadTask, newTask } from "../task/tasks.js";
import { closeTask, type PrState } from "./close.js";

const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-23T10:00:00Z") };

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

/** A task whose ledger says it shipped as PR #31, closed with `state`. */
async function closedRow(state: PrState): Promise<Record<string, unknown>> {
  const dir = await tmp("rivetari-close-ci-");
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await writeFile(join(dir, "README.md"), "demo\n");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  const draft = await newTask(
    dir,
    {
      title: "Sum the list",
      type: "fix",
      description: "total() returns 0; it should sum its list.",
      acceptance: [{ id: "A1", text: "total sums a list", verify: "unit" }],
    },
    by,
  );
  const id = draft.card.id;
  const task = await loadTask(dir, id);
  await task.ledger.append({
    beat: "ship",
    section: "timeline",
    text: "draft PR opened: #31 https://github.com/o/r/pull/31 · fix/x at abcdef123456 → main",
    by: "rivetari runtime",
    at: by.now,
  });
  await closeTask(dir, id, { ...by, prState: async () => state });
  const lines = (
    await readFile(join(dir, ".rivetari", "history.jsonl"), "utf8")
  )
    .trim()
    .split("\n");
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe("history row CI minutes", { timeout: 60_000 }, () => {
  it("records the minutes and runs the PR's CI used", async () => {
    const row = await closedRow({
      state: "closed",
      merged: true,
      ci: { minutes: 23, runs: 4, partial: false },
    });
    expect(row).toMatchObject({
      outcome: "merged",
      pr: 31,
      ci_minutes: 23,
      ci_runs: 4,
    });
  });

  it("leaves them out when the Actions API couldn't be read", async () => {
    const row = await closedRow({ state: "closed", merged: false });
    expect(row.outcome).toBe("closed");
    expect(row).not.toHaveProperty("ci_minutes");
    expect(row).not.toHaveProperty("ci_runs");
  });
});
