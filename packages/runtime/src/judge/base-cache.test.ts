import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { runTier1 } from "./tier1.js";

const LINT = `const fs = require("fs");
const bad = fs.readdirSync("src").filter((f) => fs.readFileSync("src/" + f, "utf8").includes("BAD"));
if (bad.length) { console.error("lint: BAD in " + bad.join(", ")); process.exit(1); }
`;

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

async function repo(baseSource = "module.exports = 1;\n") {
  const dir = await temp("rivetari-base-cache-test-");
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await git.addConfig("core.autocrlf", "false");
  const write = async (path: string, contents: string) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), contents, "utf8");
  };
  const commit = async (msg: string) => {
    await git.add(["-A"]);
    await git.commit(msg, ["--no-verify"]);
  };
  await write(
    "package.json",
    JSON.stringify(
      {
        name: "demo",
        private: true,
        scripts: { lint: "node lint.cjs", test: 'node -e ""' },
      },
      null,
      2,
    ),
  );
  await write("lint.cjs", LINT);
  await write("src/app.js", baseSource);
  await commit("base");
  await git.branch(["base"]);
  await git.checkoutLocalBranch("change");
  return { dir, git, write, commit };
}

function judge(dir: string, root: string, lines: string[]) {
  return runTier1({
    repoPath: dir,
    base: "base",
    checks: ["quality.lint.clean", "quality.tests.pass"],
    install: false,
    persistent: true,
    workspaceRoot: root,
    log: (line) => lines.push(line),
  });
}

describe("tier 1's base results", () => {
  it("run once per base commit and are reused by the next round, which still fails a broken check", async () => {
    const r = await repo();
    const root = await temp("rivetari-base-cache-root-");
    await r.write("src/feature.js", "module.exports = 2;\n");
    await r.commit("feature");

    const lines: string[] = [];
    const first = await judge(r.dir, root, lines);
    expect(first.verdict).toBe("pass");
    expect(lines).toContain("running checks at base");

    await r.write("src/feature.js", "module.exports = 'BAD';\n");
    await r.commit("break lint");
    lines.length = 0;
    const second = await judge(r.dir, root, lines);
    expect(lines).not.toContain("running checks at base");
    expect(lines).toContainEqual(
      expect.stringMatching(
        /^checks at base [0-9a-f]{12} already ran green: reusing quality\.lint\.clean, quality\.tests\.pass$/,
      ),
    );
    expect(second.verdict).toBe("fail");
    expect(
      second.checks.find((c) => c.id === "quality.lint.clean")?.outcome,
    ).toBe("fail");
  }, 120_000);

  it("keep only the green ones: a check red at base runs again next round, the green ones don't", async () => {
    const r = await repo("module.exports = 'BAD';\n");
    const root = await temp("rivetari-base-cache-root-");
    await r.write("src/feature.js", "module.exports = 2;\n");
    await r.commit("feature");

    const lines: string[] = [];
    await judge(r.dir, root, lines);
    lines.length = 0;
    const second = await judge(r.dir, root, lines);
    expect(lines).toContain("running checks at base");
    expect(lines).toContainEqual(
      expect.stringMatching(/already ran green: reusing quality\.tests\.pass$/),
    );
    expect(
      second.checks.find((c) => c.id === "quality.lint.clean")?.outcome,
    ).toBe("pre-existing");
  }, 120_000);

  it("run again for a new base commit", async () => {
    const r = await repo();
    const root = await temp("rivetari-base-cache-root-");
    await r.write("src/feature.js", "module.exports = 2;\n");
    await r.commit("feature");
    const lines: string[] = [];
    await judge(r.dir, root, lines);

    await r.git.checkout("base");
    await r.write("src/other.js", "module.exports = 3;\n");
    await r.commit("base moves");
    await r.git.checkout("change");
    await r.git.raw(["rebase", "base"]);
    lines.length = 0;
    await judge(r.dir, root, lines);
    expect(lines).toContain("running checks at base");
  }, 120_000);
});
