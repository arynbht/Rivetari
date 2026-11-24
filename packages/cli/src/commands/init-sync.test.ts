import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { runInit } from "./init.js";

describe("init syncs the skills it locks", { timeout: 30_000 }, () => {
  const made: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
  });
  const repo = async () => {
    const d = await mkdtemp(join(tmpdir(), "init-sync-"));
    made.push(d);
    await writeFile(join(d, "package.json"), '{"name":"tool"}\n');
    return d;
  };
  const output = () => {
    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    return () => out.mock.calls.join("");
  };

  it("runs the sync and stops telling the person to", async () => {
    const dir = await repo();
    const said = output();
    const sync = vi.fn(() =>
      Promise.resolve({ installed: ["planner"], staged: ["ui"], blocked: [] }),
    );
    expect(
      await runInit(
        dir,
        { type: "cli", yes: true },
        { token: null, syncSkills: sync },
      ),
    ).toBe(0);
    expect(sync).toHaveBeenCalledWith(dir);
    expect(said()).toContain(
      "synced the skills: 1 installed, 1 staged for tasks",
    );
    expect(said()).not.toContain("run `rivetari skills sync`");
  });

  it("says so offline, and exits 0", async () => {
    const dir = await repo();
    const said = output();
    expect(
      await runInit(dir, { type: "cli", yes: true }, { token: null }),
    ).toBe(0);
    expect(said()).toContain(
      "init ran offline, so the skills weren't synced: run `rivetari skills sync`",
    );
  });

  it("says so when the sync fails, and exits 0", async () => {
    const dir = await repo();
    const said = output();
    expect(
      await runInit(
        dir,
        { type: "cli", yes: true },
        {
          token: null,
          syncSkills: () => Promise.reject(new Error("github.com unreachable")),
        },
      ),
    ).toBe(0);
    expect(said()).toContain(
      "couldn't sync the skills (github.com unreachable): run `rivetari skills sync`",
    );
  });

  it("names a skill the sync blocked", async () => {
    const dir = await repo();
    const said = output();
    expect(
      await runInit(
        dir,
        { type: "cli", yes: true },
        {
          token: null,
          syncSkills: () =>
            Promise.resolve({
              installed: [],
              staged: [],
              blocked: [{ name: "planner", reason: "scan found 1 problem(s)" }],
            }),
        },
      ),
    ).toBe(0);
    expect(said()).toContain(
      "the skills sync blocked planner (scan found 1 problem(s)): fix that, then run `rivetari skills sync`",
    );
  });
});
