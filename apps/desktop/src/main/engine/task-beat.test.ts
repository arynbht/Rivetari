import { describe, expect, it, vi } from "vitest";

import { type BeatDeps, recordBeat } from "./task-beat";

// Every person's action on a task goes through recordBeat: one at a time per
// task, whichever action it is, with the CLI's commit messages.

const deps = (over: Partial<BeatDeps> = {}): BeatDeps => ({
  whoami: vi.fn(async () => "dev@example.com"),
  pullTasks: vi.fn(async () => ({ kept: [] })),
  commitTask: vi.fn(async () => undefined),
  ...over,
});

describe("recording a person's action", () => {
  it("pulls, takes the lease, runs the action under git's user and pushes", async () => {
    const d = deps();
    const run = vi.fn(async (by: string) => `ran as ${by}`);
    await expect(
      recordBeat(
        "/repo",
        "T-0001",
        {
          beat: "confirm",
          doing: "a confirmation of",
          noun: "the confirmation",
          run,
        },
        d,
      ),
    ).resolves.toEqual({
      by: "dev@example.com",
      result: "ran as dev@example.com",
      warning: null,
    });
    expect(d.pullTasks).toHaveBeenCalledWith("/repo");
    expect(vi.mocked(d.commitTask).mock.calls.map((c) => c[2].message)).toEqual(
      ["T-0001: confirm", "T-0001: confirm done"],
    );
    expect(vi.mocked(d.commitTask).mock.calls[0]?.[2].holder).toMatch(
      /^dev@example.com on /,
    );
  });

  it("refuses a second action on a task while one is recorded, and names the first", async () => {
    let release = () => undefined as void;
    const gate = new Promise<void>((r) => (release = r));
    const first = recordBeat(
      "/repo",
      "T-0001",
      {
        beat: "approve",
        doing: "an approval of",
        noun: "the approval",
        run: async () => gate,
      },
      deps(),
    );
    await expect(
      recordBeat(
        "/repo",
        "T-0001",
        {
          beat: "answer",
          doing: "an answer to",
          noun: "the answer",
          run: async () => 1,
        },
        deps(),
      ),
    ).rejects.toThrow("an approval of T-0001 is already being recorded");
    // Another task isn't held up.
    await expect(
      recordBeat(
        "/repo",
        "T-0002",
        {
          beat: "answer",
          doing: "an answer to",
          noun: "the answer",
          run: async () => 2,
        },
        deps(),
      ),
    ).resolves.toMatchObject({ result: 2 });
    release();
    await expect(first).resolves.toMatchObject({ warning: null });
  });

  it("keeps the action when only the last push fails, and says so in its own words", async () => {
    let calls = 0;
    const d = deps({
      commitTask: vi.fn(async () => {
        calls += 1;
        if (calls === 2) throw new Error("no route to origin");
      }),
    });
    const { warning } = await recordBeat(
      "/repo",
      "T-0003",
      {
        beat: "confirm",
        doing: "a confirmation of",
        noun: "the confirmation",
        run: async () => 0,
      },
      d,
    );
    expect(warning).toBe(
      "the confirmation is recorded, but pushing it failed: no route to origin. It's kept on this machine; the next beat on T-0003 pushes it.",
    );
  });
});
