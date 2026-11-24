import { describe, expect, it, vi } from "vitest";

import type { ProjectCheck } from "./project";
import { CHECK_EVERY_MS, ProjectChecks } from "./project-checks";

// The Project view stays current by itself: a check is held between the
// times it's due (the repo opened, a task merged, a day gone by), Refresh
// checks at once, and the records beside it are read fresh every time.

const HOUR = 60 * 60 * 1000;

function setup() {
  let clock = Date.parse("2026-11-24T09:00:00.000Z");
  let n = 0;
  const check = vi.fn(async (repoPath: string): Promise<ProjectCheck> => ({
    repoPath,
    checkedAt: new Date(clock).toISOString(),
    profileFound: true,
    fields: [],
    otherFlags: [],
    problems: [`check ${++n}`],
  }));
  const records = vi.fn(async () => ({
    openTask: null,
    profileError: null,
    autonomy: { configured: "supervised", entries: [], problems: [] },
    proof: null,
    skills: {
      locked: [],
      installed: 0,
      syncedAt: null,
      problems: [],
      gaps: [],
      error: null,
    },
    banned: { patterns: [], error: null },
  }));
  const onUpdate = vi.fn();
  const onError = vi.fn();
  const checks = new ProjectChecks({
    check,
    records,
    views: () => [],
    onUpdate,
    onError,
    now: () => clock,
  });
  return {
    checks,
    check,
    records,
    onUpdate,
    onError,
    tick: (ms: number) => (clock += ms),
  };
}

describe("ProjectChecks", () => {
  it("holds a check for a day, reading the records fresh each time", async () => {
    const { checks, check, records, tick } = setup();
    const first = await checks.view("/repo");
    expect(first.problems).toEqual(["check 1"]);
    tick(23 * HOUR);
    expect((await checks.view("/repo")).problems).toEqual(["check 1"]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(records).toHaveBeenCalledTimes(2);

    tick(HOUR);
    expect((await checks.view("/repo")).problems).toEqual(["check 2"]);
  });

  it("checks at once on Refresh", async () => {
    const { checks, check } = setup();
    await checks.view("/repo");
    expect((await checks.view("/repo", true)).problems).toEqual(["check 2"]);
    expect(check).toHaveBeenCalledTimes(2);
  });

  it("checks again when the repo opens or a task merges, and tells the view", async () => {
    const { checks, onUpdate } = setup();
    await checks.view("/repo");
    checks.recheck("/repo");
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    expect(onUpdate.mock.calls[0]?.[0]).toMatchObject({
      repoPath: "/repo",
      problems: ["check 2"],
      banned: { patterns: [] },
    });
    // What it checked is held: the tab reads it without checking again.
    expect((await checks.view("/repo")).problems).toEqual(["check 2"]);
  });

  it("runs one check per repo at a time", async () => {
    const { checks, check } = setup();
    const [a, b] = await Promise.all([
      checks.view("/repo", true),
      checks.view("/repo", true),
    ]);
    expect(check).toHaveBeenCalledTimes(1);
    expect(a.problems).toEqual(b.problems);
  });

  it("checks a held repo again once a day has passed, and not before", async () => {
    const { checks, check, onUpdate, tick } = setup();
    await checks.view("/a");
    await checks.view("/b");
    tick(CHECK_EVERY_MS - 1);
    checks.due();
    expect(check).toHaveBeenCalledTimes(2);
    tick(1);
    checks.due();
    await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(onUpdate.mock.calls.map((c) => c[0].repoPath).sort()).toEqual([
      "/a",
      "/b",
    ]);
  });

  it("says a check that fails when no one is waiting, and forgets a removed repo", async () => {
    const { checks, check, onError, tick } = setup();
    await checks.view("/repo");
    check.mockRejectedValueOnce(new Error("disk gone"));
    checks.recheck("/repo");
    await vi.waitFor(() =>
      expect(onError).toHaveBeenCalledWith("/repo", new Error("disk gone")),
    );
    checks.forget("/repo");
    tick(CHECK_EVERY_MS);
    checks.due();
    expect(check).toHaveBeenCalledTimes(2);
  });
});
