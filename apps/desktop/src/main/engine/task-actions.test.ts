import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadTask, newTask, openStops } from "@arynbht/rivetari-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type AnswerDeps,
  answerTask,
  openTaskPr,
  unwatchTasks,
  watchRepoTasks,
} from "./tasks";

// The Tasks tab's two actions, against a real repo: the answer goes through the
// runtime's own calls (pull, lease, answerStops, push), and the PR opened is the
// one the ledger records.

const BY = "dev@example.com";
const CARD = {
  type: "feature" as const,
  description: "A change that stops to ask.",
  acceptance: [{ id: "A1", text: "It works", verify: "unit" as const }],
};

let repo = "";
const savedKey = process.env.RIVETARI_LEDGER_KEY;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

async function stoppedTask(id: string, title: string): Promise<void> {
  await newTask(repo, { ...CARD, title }, { by: BY, id });
  const task = await loadTask(repo, id);
  await task.ledger.append({
    beat: "build",
    section: "stop",
    text: "asked: dependency: adds left-pad",
    by: "rivetari runtime",
  });
}

async function shippedTask(id: string, url: string): Promise<void> {
  await newTask(repo, { ...CARD, title: `Shipped ${id}` }, { by: BY, id });
  const task = await loadTask(repo, id);
  await task.ledger.append({
    beat: "ship",
    section: "timeline",
    text: `draft PR opened: #7 ${url} · rivetari/${id} at 0123456789ab → main`,
    by: BY,
  });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "rivetari-desktop-actions-"));
  process.env.RIVETARI_LEDGER_KEY = "cd".repeat(32);
  git("init", "-q", "-b", "main");
  git("config", "user.email", BY);
  git("config", "user.name", "Dev");
  git("commit", "-q", "--allow-empty", "-m", "init");
});

afterEach(async () => {
  await unwatchTasks();
  if (savedKey === undefined) delete process.env.RIVETARI_LEDGER_KEY;
  else process.env.RIVETARI_LEDGER_KEY = savedKey;
  await rm(repo, { recursive: true, force: true });
});

describe("answering a stop from the shell", () => {
  it("records the answer and note under git's user, takes the lease and pushes to the tasks branch", async () => {
    await stoppedTask("T-0001", "Add a switch");
    const result = await answerTask(repo, {
      id: "T-0001",
      allow: false,
      note: "  use the native checkbox\ninstead ",
    });
    expect(result).toMatchObject({
      id: "T-0001",
      answer: "denied",
      by: BY,
      warning: null,
    });
    expect(result.next).not.toMatch(/stop-and-ask/);

    const task = await loadTask(repo, "T-0001");
    expect(openStops(task)).toEqual([]);
    expect(task.entries.at(-1)).toMatchObject({
      section: "stop",
      text: "answered: denied — use the native checkbox instead",
      by: BY,
    });
    // On the branch, with this machine's lease, as `rivetari task answer` leaves it.
    expect(git("log", "--format=%s", "rivetari/tasks")).toContain(
      "T-0001: answer done",
    );
    expect(git("show", "rivetari/tasks:T-0001/ledger.jsonl")).toContain(
      "answered: denied",
    );
    expect(
      JSON.parse(git("show", "rivetari/tasks:T-0001/lease.json")).holder,
    ).toMatch(new RegExp(`^${BY} on `));
  });

  it("says what was wrong when nothing waits on an answer, as a plain message", async () => {
    await shippedTask("T-0002", "https://github.com/o/r/pull/7");
    await expect(
      answerTask(repo, { id: "T-0002", allow: true, note: "" }),
    ).rejects.toThrow(
      expect.objectContaining({
        name: "Error",
        message: "task T-0002 has nothing waiting on an answer",
      }),
    );
  });
});

describe("the answer's runtime calls", () => {
  const deps = (over: Partial<AnswerDeps> = {}): AnswerDeps => ({
    whoami: vi.fn(async () => BY),
    pullTasks: vi.fn(async () => ({ kept: [] })),
    commitTask: vi.fn(async () => undefined),
    answerStops: vi.fn(async () => {
      throw new Error("not stubbed");
    }) as unknown as AnswerDeps["answerStops"],
    ...over,
  });
  const done = () => loadTask(repo, "T-0001");

  it("refuses a second answer to the same task while the first is recorded", async () => {
    await stoppedTask("T-0001", "Add a switch");
    let release = () => undefined as void;
    const gate = new Promise<void>((r) => (release = r));
    const d = deps({
      answerStops: vi.fn(async () => {
        await gate;
        return done();
      }) as unknown as AnswerDeps["answerStops"],
    });
    const first = answerTask(repo, { id: "T-0001", allow: true, note: "" }, d);
    await expect(
      answerTask(repo, { id: "T-0001", allow: false, note: "" }, d),
    ).rejects.toThrow("an answer to T-0001 is already being recorded");
    release();
    await expect(first).resolves.toMatchObject({ answer: "allowed" });
    expect(d.answerStops).toHaveBeenCalledTimes(1);
    // Once it's in, the task can be answered again (the runtime decides if it may).
    await expect(
      answerTask(repo, { id: "T-0001", allow: true, note: "" }, d),
    ).resolves.toMatchObject({ answer: "allowed" });
  });

  it("pushes what it got through when the answer fails, and keeps the answer when only the last push fails", async () => {
    await stoppedTask("T-0001", "Add a switch");
    const failing = deps({
      answerStops: vi.fn(async () => {
        throw new Error("task T-0001 fails verification");
      }) as unknown as AnswerDeps["answerStops"],
    });
    await expect(
      answerTask(repo, { id: "T-0001", allow: true, note: "" }, failing),
    ).rejects.toThrow("task T-0001 fails verification");
    expect(
      vi.mocked(failing.commitTask).mock.calls.map((c) => c[2].message),
    ).toEqual(["T-0001: answer", "T-0001: answer failed"]);

    let calls = 0;
    const offline = deps({
      answerStops: vi.fn(done) as unknown as AnswerDeps["answerStops"],
      commitTask: vi.fn(async () => {
        calls += 1;
        if (calls === 2) throw new Error("git push failed: no route");
      }),
    });
    const result = await answerTask(
      repo,
      { id: "T-0001", allow: true, note: "fine" },
      offline,
    );
    expect(result.warning).toMatch(
      /recorded, but pushing it failed: git push failed: no route/,
    );
    expect(vi.mocked(offline.answerStops).mock.calls[0]?.[2]).toEqual({
      allow: true,
      note: "fine",
      by: BY,
    });
  });
});

describe("opening a task's PR", () => {
  it("opens the https URL the ledger records, and nothing else", async () => {
    await shippedTask("T-0001", "https://github.example.com/o/r/pull/7");
    await shippedTask("T-0002", "http://github.com/o/r/pull/8");
    await stoppedTask("T-0003", "No PR yet");
    await watchRepoTasks(repo, () => undefined, 60_000);
    const open = vi.fn(async () => undefined);

    await expect(openTaskPr(repo, "T-0001", open)).resolves.toEqual({
      url: "https://github.example.com/o/r/pull/7",
    });
    expect(open).toHaveBeenCalledWith("https://github.example.com/o/r/pull/7");

    await expect(openTaskPr(repo, "T-0002", open)).rejects.toThrow(
      "isn't https",
    );
    await expect(openTaskPr(repo, "T-0003", open)).rejects.toThrow(
      "has no PR yet",
    );
    await expect(openTaskPr(repo, "T-0009", open)).rejects.toThrow(
      "isn't one of the tasks on show",
    );
    await expect(
      openTaskPr(join(repo, "other"), "T-0001", open),
    ).rejects.toThrow("isn't one of the tasks on show");
    expect(open).toHaveBeenCalledTimes(1);

    await unwatchTasks();
    await expect(openTaskPr(repo, "T-0001", open)).rejects.toThrow(
      "isn't one of the tasks on show",
    );
  });
});
