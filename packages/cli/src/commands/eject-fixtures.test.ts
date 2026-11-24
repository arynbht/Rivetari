import { execFile } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runEject } from "./eject.js";
import { runInit } from "./init.js";

const run = promisify(execFile);

// One small repo per stack, each with its own commands and ignore rules.
const FIXTURES: Record<string, Record<string, string>> = {
  node: {
    "package.json": `${JSON.stringify(
      {
        name: "tool",
        version: "1.0.0",
        private: true,
        scripts: { lint: "node --check index.js", test: "node --test" },
      },
      null,
      2,
    )}\n`,
    "index.js": "exports.add = (a, b) => a + b;\n",
    "index.test.js":
      'const test = require("node:test");\nconst assert = require("node:assert");\nconst { add } = require("./index.js");\ntest("adds", () => assert.strictEqual(add(1, 2), 3));\n',
    ".gitignore": "node_modules/\n",
  },
  python: {
    "pyproject.toml":
      '[project]\nname = "tool"\nversion = "0.1.0"\n\n[tool.pytest.ini_options]\ntestpaths = ["tests"]\n',
    "src/tool/__init__.py": "def add(a, b):\n    return a + b\n",
    "tests/test_tool.py":
      "from tool import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n",
    ".gitignore": "__pycache__/\n.venv/\n",
  },
  go: {
    "go.mod": "module example.com/tool\n\ngo 1.22\n",
    "main.go":
      'package main\n\nimport "fmt"\n\nfunc add(a, b int) int { return a + b }\n\nfunc main() { fmt.Println(add(1, 2)) }\n',
    "main_test.go":
      'package main\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif add(1, 2) != 3 {\n\t\tt.Fatal("add")\n\t}\n}\n',
  },
  rust: {
    "Cargo.toml":
      '[package]\nname = "tool"\nversion = "0.1.0"\nedition = "2021"\n',
    "src/main.rs":
      'fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\nfn main() {\n    println!("{}", add(1, 2));\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {\n        assert_eq!(super::add(1, 2), 3);\n    }\n}\n',
    ".gitignore": "/target\n",
  },
};

/** Every file under `dir`, by its path relative to it, links read through. */
async function snapshot(dir: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (at: string) => {
    for (const e of await readdir(at, { withFileTypes: true })) {
      const abs = join(at, e.name);
      if (e.isDirectory() || e.isSymbolicLink()) {
        const inside = await readdir(abs).then(
          () => true,
          () => false,
        );
        if (inside) {
          await walk(abs);
          continue;
        }
      }
      files.set(
        relative(dir, abs).split("\\").join("/"),
        await readFile(abs, "utf8"),
      );
    }
  };
  await walk(dir);
  return files;
}

/**
 * What a synced machine has beyond what init writes offline: an installed
 * skill (its copy and its link) and the floorplan map.
 */
async function asIfSyncedAndMapped(dir: string): Promise<void> {
  const copy = join(dir, ".agents", "skills", "planner");
  await mkdir(copy, { recursive: true });
  await writeFile(join(copy, "SKILL.md"), "# planner\n");
  await writeFile(join(dir, ".agents", "skills", ".gitignore"), "*\n");
  const link = join(dir, ".claude", "skills", "planner");
  await symlink(copy, link, "junction").catch(() =>
    cp(copy, link, { recursive: true }),
  );
  await writeFile(
    join(dir, ".claude", "skills", ".gitignore"),
    "# rivetari skills (managed by `rivetari skills sync`)\n/planner\n# end rivetari skills\n",
  );
  await writeFile(
    join(dir, ".rivetari", "skills.state.json"),
    JSON.stringify({
      syncedAt: "2026-11-23T00:00:00.000Z",
      lock: "x",
      skills: [
        {
          name: "planner",
          pin: "a",
          hash: "b",
          scope: "always",
          installed: true,
          from: "cache",
        },
      ],
      blocked: [],
    }),
  );
  await mkdir(join(dir, "floorplan", "descriptions"), { recursive: true });
  await writeFile(join(dir, "floorplan", "architecture.json"), "{}\n");
  await writeFile(join(dir, "floorplan", "index.html"), "<html></html>\n");
}

describe("eject after init", { timeout: 60_000 }, () => {
  const made: string[] = [];
  const savedConfig = process.env.RIVETARI_CONFIG_DIR;
  beforeEach(async () => {
    const config = await mkdtemp(join(tmpdir(), "rivetari-config-"));
    made.push(config);
    process.env.RIVETARI_CONFIG_DIR = config;
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
    else process.env.RIVETARI_CONFIG_DIR = savedConfig;
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
  });

  for (const [stack, files] of Object.entries(FIXTURES)) {
    it(`leaves a ${stack} repo as it was, with its evidence and no Rivetari`, async () => {
      const dir = await mkdtemp(join(tmpdir(), `eject-${stack}-`));
      made.push(dir);
      for (const [rel, text] of Object.entries(files)) {
        await mkdir(join(dir, rel, ".."), { recursive: true });
        await writeFile(join(dir, rel), text);
      }
      const before = await snapshot(dir);

      expect(
        await runInit(dir, { type: "cli", yes: true }, { token: null }),
      ).toBe(0);
      await asIfSyncedAndMapped(dir);
      if (stack === "node")
        await writeFile(
          join(dir, ".rivetari", "evidence.yml"),
          "- control: sec-threat-model\n  url: https://example.com/threat-model\n  date: 2026-11-01\n",
        );
      const initialised = await snapshot(dir);

      // The dry run changes nothing.
      expect(await runEject(dir, {})).toBe(0);
      expect(await snapshot(dir)).toEqual(initialised);

      expect(await runEject(dir, { yes: true })).toBe(0);
      const after = await snapshot(dir);

      // The repo's own files are byte for byte what they were, so its
      // commands do what they did before init.
      for (const [rel, text] of before) expect(after.get(rel), rel).toBe(text);
      // Everything init wrote went, since none of it changed; only the
      // evidence, a person's record, is left over.
      const added = [...after.keys()].filter((k) => !before.has(k)).sort();
      expect(added).toEqual(
        stack === "node" ? ["docs/evidence/evidence.yml"] : [],
      );
      for (const [rel, text] of after) {
        expect(rel).not.toMatch(/rivetari/i);
        expect(text, rel).not.toMatch(/rivetari/i);
      }
      if (stack === "node") {
        expect(after.get("docs/evidence/evidence.yml")).toContain(
          "sec-threat-model",
        );
        await run(process.execPath, ["--test"], { cwd: dir });
      }
    });
  }

  const initialise = async (files: Record<string, string>) => {
    const dir = await mkdtemp(join(tmpdir(), "eject-own-"));
    made.push(dir);
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(join(dir, rel, ".."), { recursive: true });
      await writeFile(join(dir, rel), text);
    }
    expect(
      await runInit(dir, { type: "cli", yes: true }, { token: null }),
    ).toBe(0);
    return dir;
  };

  it("puts back the CLAUDE.md and .gitattributes init changed, from what it recorded", async () => {
    const claude = "# CLAUDE.md\n\nUse tabs, not spaces.\n";
    const dir = await initialise({
      "CLAUDE.md": claude,
      ".gitattributes": "* text=auto\n",
    });
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).not.toBe(claude);
    expect(await runEject(dir, { yes: true })).toBe(0);
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(claude);
    expect(
      (await readdir(dir)).filter((n) => n.startsWith("CLAUDE.md.bak")),
    ).toEqual([]);
    expect(await readdir(dir)).not.toContain("AGENTS.md");
    // Init appended to .gitattributes without a backup: it stays, with the line named.
    expect(await readFile(join(dir, ".gitattributes"), "utf8")).toContain(
      ".rivetari/** text eol=lf",
    );
    const printed = vi
      .mocked(process.stdout.write)
      .mock.calls.map((c) => String(c[0]))
      .join("");
    expect(printed).toContain(
      "  .gitattributes (init added these lines to it)\n      2: .rivetari/** text eol=lf\n",
    );
  });

  it("leaves a doc edited after init, and lists what in it names Rivetari", async () => {
    const dir = await initialise({ "README.md": "# tool\n" });
    const agents = `${await readFile(join(dir, "AGENTS.md"), "utf8")}\nUse tabs.\n`;
    await writeFile(join(dir, "AGENTS.md"), agents);
    expect(await runEject(dir, { yes: true })).toBe(0);
    expect(await readFile(join(dir, "AGENTS.md"), "utf8")).toBe(agents);
    expect(await readdir(dir)).not.toContain("CONSTRAINTS.md");
    const printed = vi
      .mocked(process.stdout.write)
      .mock.calls.map((c) => String(c[0]))
      .join("");
    expect(printed).toContain(
      "  AGENTS.md (changed since init, so eject leaves it)\n",
    );
    expect(printed).toMatch(/ {6}\d+: .*rivetari/i);
  });

  it("keeps how a file first came to be across a re-init", async () => {
    const claude = "# CLAUDE.md\n\nUse tabs, not spaces.\n";
    const dir = await initialise({ "CLAUDE.md": claude });
    expect(
      await runInit(
        dir,
        { type: "cli", yes: true, force: true },
        { token: null },
      ),
    ).toBe(0);
    expect(await runEject(dir, { yes: true })).toBe(0);
    expect(await readFile(join(dir, "CLAUDE.md"), "utf8")).toBe(claude);
    expect(await readdir(dir)).not.toContain("AGENTS.md");
  });
});
