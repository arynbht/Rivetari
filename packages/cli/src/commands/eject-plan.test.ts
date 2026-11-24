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

import { runEject, stripRivetari } from "./eject.js";
import { SETTINGS_JSON } from "./init-files.js";

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
    await writeFile(join(dir, "CLAUDE.md"), "# CLAUDE.md\n\n@AGENTS.md\n");
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

  it("takes only Rivetari's hooks out of .claude/settings.json", async () => {
    const dir = await repo();
    const ours = JSON.parse(SETTINGS_JSON) as {
      hooks: { PreToolUse: unknown[] };
    };
    const theirs = {
      model: "opus",
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "audit.sh" }],
          },
          ...ours.hooks.PreToolUse,
        ],
        SessionStart: (
          JSON.parse(SETTINGS_JSON) as { hooks: { SessionStart: unknown[] } }
        ).hooks.SessionStart,
      },
    };
    await mkdir(join(dir, ".claude"));
    await writeFile(
      join(dir, ".claude", "settings.json"),
      JSON.stringify(theirs, null, 2),
    );
    expect(await runEject(dir, { yes: true })).toBe(0);
    expect(
      JSON.parse(await readFile(join(dir, ".claude", "settings.json"), "utf8")),
    ).toEqual({
      model: "opus",
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "audit.sh" }],
          },
        ],
      },
    });
  });

  it("keeps a CLAUDE.md with rules of its own, without the /rivetari line", async () => {
    const dir = await repo();
    await writeFile(
      join(dir, "CLAUDE.md"),
      "# CLAUDE.md\n\n@AGENTS.md\n\nStart every task with `/rivetari`. The contract above applies to Claude Code too.\n\nUse tabs.\n",
    );
    expect(await runEject(dir, { yes: true })).toBe(0);
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(
      "# CLAUDE.md\n\n@AGENTS.md\n\nUse tabs.\n",
    );
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

  it("names the task records that go with .rivetari/", async () => {
    const dir = await repo();
    await mkdir(join(dir, ".rivetari", "tasks", "T-0004"), { recursive: true });
    expect(
      await runEject(dir, {}, { openTasks: () => Promise.resolve([]) }),
    ).toBe(0);
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

describe("stripRivetari", () => {
  it("drops the sections, items and paragraphs that mention it and keeps the rest", () => {
    const doc = [
      "# Guide",
      "",
      "Run `rivetari doctor` first.",
      "",
      "## Using Rivetari",
      "",
      "It runs the beats.",
      "",
      "### Details",
      "",
      "More.",
      "",
      "## Rules",
      "",
      "- keep it small",
      "- ask `/rivetari` first",
      "  before anything",
      "- no secrets",
      "",
      "```sh",
      "rivetari task new",
      "```",
      "",
    ].join("\n");
    expect(stripRivetari(doc)).toBe(
      "# Guide\n\n## Rules\n\n- keep it small\n- no secrets\n",
    );
  });

  it("keeps CRLF line endings", () => {
    expect(stripRivetari("# A\r\n\r\nRivetari here.\r\n\r\nKept.\r\n")).toBe(
      "# A\r\n\r\nKept.\r\n",
    );
  });

  it("drops an item with its sub-items and indented continuation", () => {
    expect(
      stripRivetari(
        "# A\n\n- Use Rivetari for:\n  - lint\n  - tests\n\n  Then wait.\n- Keep it small\n  - really\n",
      ),
    ).toBe("# A\n\n- Keep it small\n  - really\n");
  });

  it("skips a fenced block in a dropped section, # lines and all", () => {
    expect(
      stripRivetari(
        "# Doc\n\n## Using Rivetari\n\n```sh\n# set up\nrivetari init\n```\n\n## Other\n\nText.\n",
      ),
    ).toBe("# Doc\n\n## Other\n\nText.\n");
  });

  it("leaves # lines in a kept fenced block alone", () => {
    const doc = "# Doc\n\n```sh\n# one\n# two\nmake\n```\n";
    expect(stripRivetari(doc)).toBe(doc);
  });
});

describe("the dry run", () => {
  it("shows the lines it would take out of a kept doc", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eject-diff-"));
    try {
      await writeFile(
        join(dir, "DESIGN.md"),
        "# Design\n\nRun /rivetari first.\n\nUse the tokens.\n",
      );
      const out: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((s) => {
        out.push(String(s));
        return true;
      });
      expect(
        await runEject(dir, {}, { openTasks: () => Promise.resolve([]) }),
      ).toBe(0);
      expect(out.join("")).toContain(
        "Would edit:\n  DESIGN.md (drop what refers to Rivetari)\n      - Run /rivetari first.\n",
      );
      expect(await readFile(join(dir, "DESIGN.md"), "utf8")).toContain(
        "/rivetari",
      );
    } finally {
      vi.restoreAllMocks();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
