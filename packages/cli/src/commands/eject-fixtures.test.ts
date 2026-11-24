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
import { basename, join, relative } from "node:path";
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
 * skill (its copy and its link), the floorplan map and its ignore line.
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
  const ignore = await readFile(join(dir, ".gitignore"), "utf8").catch(
    () => "",
  );
  await writeFile(join(dir, ".gitignore"), `${ignore}/floorplan/\n`);
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
    it(`leaves a ${stack} repo as it was, with its docs and CI and no Rivetari`, async () => {
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
      const added = [...after.keys()].filter((k) => !before.has(k)).sort();
      expect(added).toEqual(
        [
          ".github/PULL_REQUEST_TEMPLATE.md",
          "AGENTS.md",
          "CONSTRAINTS.md",
          ...(stack === "node"
            ? [".github/workflows/ci.yml", "docs/evidence/evidence.yml"]
            : []),
        ].sort(),
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
      const agents = after.get("AGENTS.md")!;
      expect(agents).toContain("## Protected paths");
      expect(agents).toContain("## Stop and ask");
      expect(agents).toContain("## This repo");
      expect(agents).toContain(`- **${basename(dir)}**: cli`);
      expect(agents).not.toContain("## The beats");
    });
  }
});
