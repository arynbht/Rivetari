import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEject, withoutInitHeader } from "./eject.js";

const run = promisify(execFile);

describe("withoutInitHeader", () => {
  it("drops a one-sentence header line and leaves the YAML key under it", () => {
    expect(
      withoutInitHeader(
        "# Written by `rivetari init` for node.\n\non:\n  pull_request:\n",
      ),
    ).toBe("\non:\n  pull_request:\n");
    expect(
      withoutInitHeader("# Written by `rivetari init` for node.\non: push\n"),
    ).toBe("on: push\n");
  });

  it("keeps the rest of a header line after the sentence", () => {
    expect(
      withoutInitHeader(
        "# Written by `rivetari init` for a public repo. Every OS runs.\nname: ci\n",
      ),
    ).toBe("# Every OS runs.\nname: ci\n");
  });
});

describe("eject's plan, round three", () => {
  const made: string[] = [];
  let out: string[];
  let err: string[];
  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((s) => {
      out.push(String(s));
      return true;
    });
    vi.spyOn(console, "error").mockImplementation((s) => {
      err.push(String(s));
    });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
  });
  const repo = async () => {
    const d = await mkdtemp(join(tmpdir(), "eject-round3-"));
    made.push(d);
    await mkdir(join(d, ".rivetari"));
    await writeFile(join(d, ".rivetari", "profile.yml"), "version: 1\n");
    return d;
  };
  const none = { openTasks: () => Promise.resolve([]) };

  it("keeps the on: key of a ci.yml whose header is one sentence", async () => {
    const dir = await repo();
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(dir, ".github", "workflows", "ci.yml"),
      "# Written by `rivetari init` for node.\non:\n  pull_request:\njobs: {}\n",
    );
    expect(await runEject(dir, { yes: true }, none)).toBe(0);
    expect(
      await readFile(join(dir, ".github", "workflows", "ci.yml"), "utf8"),
    ).toBe("on:\n  pull_request:\njobs: {}\n");
  });

  it("doesn't list a doc as kept when stripping leaves nothing of it", async () => {
    const dir = await repo();
    await writeFile(join(dir, "DESIGN.md"), "Use Rivetari's tokens.\n");
    expect(await runEject(dir, { yes: true }, none)).toBe(0);
    expect(out.join("")).not.toMatch(/Kept[^\n]*DESIGN\.md/);
    expect(out.join("")).toContain("DESIGN.md (drop what refers to Rivetari");
  });

  it("leaves the floorplan ignore line while floorplan/ is the project's own", async () => {
    const dir = await repo();
    await mkdir(join(dir, "floorplan"));
    await writeFile(join(dir, "floorplan", "kitchen.svg"), "<svg/>\n");
    await writeFile(join(dir, ".gitignore"), "/floorplan/\n.rivetari/cache/\n");
    expect(await runEject(dir, { yes: true }, none)).toBe(0);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(
      "/floorplan/\n",
    );
  });

  it("reads tasks without pulling on a dry run, and pulls under --yes", async () => {
    const dir = await repo();
    await run("git", ["init", "-q"], { cwd: dir });
    await run("git", ["remote", "add", "origin", join(dir, "no-such-remote")], {
      cwd: dir,
    });
    expect(await runEject(dir, {})).toBe(0);
    expect(out.join("")).toContain(
      "Open tasks were read from this checkout's records without pulling",
    );
    expect(await runEject(dir, { yes: true })).toBe(1);
    expect(err.join("")).toContain("couldn't read the task records");
  });
});
