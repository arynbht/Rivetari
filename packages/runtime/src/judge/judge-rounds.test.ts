// Every judge round of a task, for the desktop shell's task detail: each
// record checked against the hash its own verdict sealed, a bad one kept with
// why. The plan and a person's allowed stops read from the ledger alone, so a
// watcher's view of the task will do.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { taskPlan } from "../agent/build.js";
import {
  allowedDecisions,
  loadTask,
  newTask,
  sha256,
  TASKS_DIR,
} from "../task/tasks.js";
import { loadJudgeRecord, loadJudgeRounds } from "./task-judge.js";

const BY = "dev@example.com";
const savedKey = process.env.RIVETARI_LEDGER_KEY;
let repo = "";

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "rivetari-judge-rounds-"));
  process.env.RIVETARI_LEDGER_KEY = "ef".repeat(32);
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", BY);
  await git.addConfig("user.name", "Dev");
});

afterEach(async () => {
  if (savedKey === undefined) delete process.env.RIVETARI_LEDGER_KEY;
  else process.env.RIVETARI_LEDGER_KEY = savedKey;
  await rm(repo, { recursive: true, force: true });
});

const record = (round: number, verdict: string) =>
  `${JSON.stringify({ task: "T-0001", round, verdict, head: "0123456789ab", base: "main", tier1: { verdict: "pass", checks: [], protected: [], notes: [] } }, null, 2)}\n`;

async function judged(): Promise<void> {
  await newTask(
    repo,
    {
      title: "Add a switch",
      type: "feature",
      description: "A switch.",
      acceptance: [{ id: "A1", text: "It switches", verify: "unit" }],
    },
    { by: BY, id: "T-0001" },
  );
  const task = await loadTask(repo, "T-0001");
  const append = (
    beat: "build" | "judge",
    section: "timeline" | "plan" | "stop",
    text: string,
  ) => task.ledger.append({ beat, section, text, by: BY });
  await append("build", "timeline", "build started · skills none");
  await append("build", "plan", "1. Write the old plan");
  await append("build", "timeline", "build started · skills none");
  await append("build", "plan", "1. Add the switch");
  await append("build", "plan", "2. Test it");
  const dir = join(repo, TASKS_DIR, "T-0001", "judge");
  await mkdir(dir, { recursive: true });
  const one = record(1, "failed");
  await writeFile(join(dir, "round-1.json"), one);
  await append(
    "judge",
    "timeline",
    `judge failed · round 1 · head 0123456789ab · 1 blocking · record sha256 ${sha256(one)}`,
  );
  // Round 2's file was changed after it was sealed.
  const two = record(2, "needs a human");
  await writeFile(join(dir, "round-2.json"), two.replace("main", "other"));
  await append("judge", "stop", "asked: unverified_acceptance: A1 (no test)");
  await append(
    "judge",
    "timeline",
    `judge needs a human · round 2 · head 0123456789ab · record sha256 ${sha256(two)}`,
  );
  await append("judge", "stop", "answered: allowed — checked it by hand");
}

describe("a task's judge rounds", () => {
  it("reads every round, oldest first, and keeps one that fails its seal with why", async () => {
    await judged();
    const task = await loadTask(repo, "T-0001");
    const rounds = await loadJudgeRounds(repo, task);
    expect(rounds.map((r) => [r.round, r.verdict])).toEqual([
      [1, "failed"],
      [2, "needs a human"],
    ]);
    expect(rounds[0]).toMatchObject({
      problem: null,
      record: { round: 1, verdict: "failed" },
    });
    expect(rounds[1]).toMatchObject({
      record: null,
      problem: `${TASKS_DIR}/T-0001/judge/round-2.json doesn't match the record sealed in the ledger`,
    });
    expect(rounds[1]?.at).toMatch(/^\d{4}-\d\d-\d\dT/);
    // The latest round alone still throws, as ship relies on.
    await expect(loadJudgeRecord(repo, task)).rejects.toThrow(
      "doesn't match the record sealed",
    );
  });

  it("is empty before the first verdict, and a missing file is a problem, not a throw", async () => {
    await newTask(
      repo,
      {
        title: "Nothing judged",
        type: "chore",
        description: "Nothing yet.",
        acceptance: [{ id: "A1", text: "Done", verify: "review" }],
      },
      { by: BY, id: "T-0002" },
    );
    const task = await loadTask(repo, "T-0002");
    expect(await loadJudgeRounds(repo, task)).toEqual([]);
    expect(await loadJudgeRecord(repo, task)).toBeNull();
    await task.ledger.append({
      beat: "judge",
      section: "timeline",
      text: `judge passed · round 1 · head 0123456789ab · record sha256 ${"0".repeat(64)}`,
      by: BY,
    });
    const rounds = await loadJudgeRounds(repo, await loadTask(repo, "T-0002"));
    expect(rounds).toEqual([
      expect.objectContaining({
        round: 1,
        verdict: "passed",
        record: null,
        problem: expect.stringContaining("round-1.json doesn't match"),
      }),
    ]);
  });
});

describe("what a watcher's view of a task can be read for", () => {
  it("the latest plan and the stops a person allowed, from the entries alone", async () => {
    await judged();
    const { entries } = await loadTask(repo, "T-0001");
    expect(taskPlan({ entries })).toEqual(["Add the switch", "Test it"]);
    expect(allowedDecisions({ entries })).toEqual([
      expect.objectContaining({
        asked: "unverified_acceptance: A1 (no test)",
        by: BY,
        note: "checked it by hand",
      }),
    ]);
  });
});
