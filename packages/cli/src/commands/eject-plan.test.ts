import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { newTask } from "@arynbht/rivetari-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEject } from "./eject.js";
import { SETTINGS_JSON } from "./init-files.js";
import { contentHash, type ManifestEntry } from "./init-manifest.js";

const run = promisify(execFile);

const there = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("runEject's plan", () => {
  const made: string[] = [];
  const savedConfig = process.env.RIVETARI_CONFIG_DIR;
  let out: string[];
  let err: string[];
  beforeEach(async () => {
    const config = await mkdtemp(join(tmpdir(), "eject-config-"));
    made.push(config);
    process.env.RIVETARI_CONFIG_DIR = config;
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
    if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
    else process.env.RIVETARI_CONFIG_DIR = savedConfig;
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
  });
  const repo = async () => {
    const d = await mkdtemp(join(tmpdir(), "eject-plan-"));
    made.push(d);
    await mkdir(join(d, ".rivetari"));
    await writeFile(join(d, ".rivetari", "profile.yml"), "version: 1\n");
    return d;
  };
  /** Write `files` and a manifest recording them as init left them. */
  const initWrote = async (
    dir: string,
    files: Record<string, { text: string } & Omit<ManifestEntry, "sha256">>,
  ) => {
    const entries: Record<string, ManifestEntry> = {};
    for (const [rel, { text, ...origin }] of Object.entries(files)) {
      await mkdir(join(dir, rel, ".."), { recursive: true });
      await writeFile(join(dir, rel), text);
      entries[rel] = { sha256: contentHash(text), ...origin };
    }
    await writeFile(
      join(dir, ".rivetari", "manifest.json"),
      JSON.stringify({ version: 1, files: entries }),
    );
  };
  const none = { openTasks: () => Promise.resolve([]) };

  it("is a dry run without --yes, listing what it would do", async () => {
    const dir = await repo();
    expect(await runEject(dir, {})).toBe(0);
    expect(out.join("")).toContain("Dry run: nothing has changed");
    expect(out.join("")).toContain("Would remove:\n  .rivetari/\n");
    expect(await there(join(dir, ".rivetari", "profile.yml"))).toBe(true);
    expect(await runEject(dir, { apply: true })).toBe(0);
    expect(await there(join(dir, ".rivetari"))).toBe(false);
  });

  it("refuses while a task is open, from the runtime's own records", async () => {
    const dir = await repo();
    await newTask(
      dir,
      {
        title: "Add a flag",
        type: "feature",
        description: "A flag.",
        acceptance: [{ id: "A1", text: "It parses", verify: "unit" }],
      },
      { by: "dev@example.com" },
    );
    expect(await runEject(dir, { yes: true })).toBe(1);
    expect(err.join("")).toContain("T-0001 is still open");
    expect(await there(join(dir, ".rivetari", "profile.yml"))).toBe(true);
  });

  it("refuses when the task listing names an open task, changing nothing", async () => {
    const dir = await repo();
    await initWrote(dir, {
      "CLAUDE.md": { text: "# CLAUDE.md\n\n@AGENTS.md\n", created: true },
    });
    expect(
      await runEject(
        dir,
        { yes: true },
        { openTasks: () => Promise.resolve(["T-0002", "T-0003"]) },
      ),
    ).toBe(1);
    expect(err.join("")).toContain("T-0002, T-0003 are still open");
    expect(await there(join(dir, "CLAUDE.md"))).toBe(true);
  });

  it("refuses when the listing had to skip a task record", async () => {
    const dir = await repo();
    await mkdir(join(dir, ".rivetari", "tasks", "T-0007"), { recursive: true });
    expect(await runEject(dir, { yes: true })).toBe(1);
    expect(err.join("")).toContain("couldn't read the task records");
    expect(err.join("")).toContain("T-0007");
    expect(await there(join(dir, ".rivetari", "profile.yml"))).toBe(true);
  });

  it("refuses when the tasks branch can't be fetched, rather than trust the local copy", async () => {
    const dir = await repo();
    await run("git", ["init", "-q"], { cwd: dir });
    await run("git", ["remote", "add", "origin", join(dir, "no-such-remote")], {
      cwd: dir,
    });
    expect(await runEject(dir, { yes: true })).toBe(1);
    expect(err.join("")).toContain("couldn't read the task records");
    expect(await there(join(dir, ".rivetari", "profile.yml"))).toBe(true);
  });

  it("refuses when git itself fails, rather than read that as no origin", async () => {
    const dir = await repo();
    await run("git", ["init", "-q"], { cwd: dir });
    const config = join(dir, ".git", "config");
    await writeFile(config, `${await readFile(config, "utf8")}\n[broken\n`);
    expect(await runEject(dir, { yes: true })).toBe(1);
    expect(err.join("")).toContain("git couldn't read the repo");
    expect(await there(join(dir, ".rivetari", "profile.yml"))).toBe(true);
  });

  it("deletes what init created and puts back what it replaced, while unchanged", async () => {
    const dir = await repo();
    await initWrote(dir, {
      "AGENTS.md": { text: "# AGENTS.md\n\nRun /rivetari.\n", created: true },
      "CLAUDE.md": {
        text: "# CLAUDE.md\n\n@AGENTS.md\n",
        backup: "CLAUDE.md.bak",
      },
      ".claude/settings.json": { text: SETTINGS_JSON, created: true },
    });
    await writeFile(join(dir, "CLAUDE.md.bak"), "# Ours\n\nUse tabs.\n");
    expect(await runEject(dir, {}, none)).toBe(0);
    expect(out.join("")).toContain(
      "Would put back from init's backups:\n  CLAUDE.md (from CLAUDE.md.bak)\n",
    );
    expect(await runEject(dir, { yes: true }, none)).toBe(0);
    expect(await there(join(dir, "AGENTS.md"))).toBe(false);
    expect(await there(join(dir, ".claude"))).toBe(false);
    expect(await there(join(dir, "CLAUDE.md.bak"))).toBe(false);
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(
      "# Ours\n\nUse tabs.\n",
    );
  });

  it("counts a file whose line endings a checkout changed as unchanged", async () => {
    const dir = await repo();
    await initWrote(dir, {
      "AGENTS.md": { text: "# AGENTS.md\n\nRun /rivetari.\n", created: true },
    });
    await writeFile(
      join(dir, "AGENTS.md"),
      "# AGENTS.md\r\n\r\nRun /rivetari.\r\n",
    );
    expect(await runEject(dir, { yes: true }, none)).toBe(0);
    expect(await there(join(dir, "AGENTS.md"))).toBe(false);
  });

  it("leaves a file changed since init as it is and lists its Rivetari lines", async () => {
    const dir = await repo();
    await initWrote(dir, {
      "AGENTS.md": { text: "# AGENTS.md\n\nRun /rivetari.\n", created: true },
      "CLAUDE.md": {
        text: "# CLAUDE.md\n\n@AGENTS.md\n",
        backup: "CLAUDE.md.bak",
      },
    });
    const agents = "# AGENTS.md\n\nRun /rivetari.\n\nUse tabs.\n";
    await writeFile(join(dir, "AGENTS.md"), agents);
    await writeFile(join(dir, "CLAUDE.md"), "# CLAUDE.md\n\nOurs now.\n");
    await writeFile(join(dir, "CLAUDE.md.bak"), "# Ours\n");
    expect(await runEject(dir, { yes: true }, none)).toBe(0);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(agents);
    expect(await readFile(join(dir, "CLAUDE.md.bak"), "utf8")).toBe("# Ours\n");
    expect(out.join("")).toContain(
      "  AGENTS.md (changed since init, so eject leaves it)\n      3: Run /rivetari.\n",
    );
    expect(out.join("")).toContain(
      "CLAUDE.md (changed since init, so eject leaves it; the file from before init is CLAUDE.md.bak)",
    );
  });

  it("lists the exact lines init appended to a file of the repo's own", async () => {
    const dir = await repo();
    const line = ".rivetari/** text eol=lf";
    await initWrote(dir, {
      ".gitattributes": { text: `* text=auto\n${line}\n`, added: [line] },
    });
    expect(await runEject(dir, { yes: true }, none)).toBe(0);
    expect(await readFile(join(dir, ".gitattributes"), "utf8")).toBe(
      `* text=auto\n${line}\n`,
    );
    expect(out.join("")).toContain(
      `  .gitattributes (init added these lines to it)\n      2: ${line}\n`,
    );
  });

  it("never edits a doc init didn't record, whatever its title says", async () => {
    const dir = await repo();
    const design =
      "# Design for the Rivetari dashboard\n\n## Colours\n\nUse blue.\n";
    await writeFile(join(dir, "DESIGN.md"), design);
    expect(await runEject(dir, { yes: true }, none)).toBe(0);
    expect(await readFile(join(dir, "DESIGN.md"), "utf8")).toBe(design);
    expect(out.join("")).toContain(
      "  DESIGN.md (init kept no record of what it wrote here (it predates the manifest), so eject leaves it)\n      1: # Design for the Rivetari dashboard\n",
    );
  });

  it("leaves .claude/settings.json with Rivetari's hooks in it when init has no record of it", async () => {
    const dir = await repo();
    await mkdir(join(dir, ".claude"));
    await writeFile(join(dir, ".claude", "settings.json"), SETTINGS_JSON);
    expect(await runEject(dir, { yes: true }, none)).toBe(0);
    expect(await readFile(join(dir, ".claude", "settings.json"), "utf8")).toBe(
      SETTINGS_JSON,
    );
    expect(out.join("")).toContain("  .claude/settings.json (");
  });

  it("refuses when the manifest won't parse", async () => {
    const dir = await repo();
    await writeFile(join(dir, ".rivetari", "manifest.json"), "{ not json");
    expect(await runEject(dir, { yes: true }, none)).toBe(1);
    expect(err.join("")).toContain("couldn't work out what to remove");
    expect(await there(join(dir, ".rivetari", "profile.yml"))).toBe(true);
  });

  it("moves evidence out of .rivetari/ and won't overwrite evidence already there", async () => {
    const dir = await repo();
    await mkdir(join(dir, ".rivetari", "evidence"));
    await writeFile(join(dir, ".rivetari", "evidence", "pentest.pdf"), "x");
    await mkdir(join(dir, "docs", "evidence"), { recursive: true });
    await writeFile(join(dir, "docs", "evidence", "pentest.pdf"), "theirs");
    expect(await runEject(dir, { yes: true })).toBe(1);
    expect(err.join("")).toContain(
      "docs/evidence/pentest.pdf is already there, so .rivetari/evidence/pentest.pdf has nowhere to go",
    );
    expect(await there(join(dir, ".rivetari", "evidence", "pentest.pdf"))).toBe(
      true,
    );
    await rm(join(dir, "docs"), { recursive: true });
    expect(await runEject(dir, { yes: true })).toBe(0);
    expect(
      await readFile(join(dir, "docs", "evidence", "pentest.pdf"), "utf8"),
    ).toBe("x");
    expect(out.join("")).toContain(
      "Moved .rivetari/evidence/pentest.pdf to docs/evidence/pentest.pdf",
    );
  });

  it("names the task records that go with .rivetari/", async () => {
    const dir = await repo();
    await mkdir(join(dir, ".rivetari", "tasks", "T-0004"), { recursive: true });
    expect(await runEject(dir, {}, none)).toBe(0);
    expect(out.join("")).toContain(".rivetari/ holds the records of T-0004");
  });

  it("leaves a repo's own skills and workflows where they are", async () => {
    const dir = await repo();
    await mkdir(join(dir, ".claude", "skills", "house"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "skills", "house", "SKILL.md"),
      "# house\n",
    );
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(dir, ".github", "workflows", "release.yml"),
      "name: release\n",
    );
    await writeFile(
      join(dir, ".github", "workflows", "rivetari.yml"),
      "name: rivetari\n",
    );
    expect(await runEject(dir, { yes: true })).toBe(0);
    expect(
      await there(join(dir, ".claude", "skills", "house", "SKILL.md")),
    ).toBe(true);
    expect(await there(join(dir, ".github", "workflows", "release.yml"))).toBe(
      true,
    );
    expect(await there(join(dir, ".github", "workflows", "rivetari.yml"))).toBe(
      false,
    );
  });
});
