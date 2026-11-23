import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { runTier1 } from "./tier1.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const FLAKY = `const fs = require("fs");
if (fs.existsSync(".ran-once")) process.exit(0);
fs.writeFileSync(".ran-once", "");
console.error("flaked");
process.exit(1);
`;
const BROKEN = `console.error("broken"); process.exit(1);\n`;

async function repo(changed: string) {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-flaky-test-"));
  made.push(dir);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await git.addConfig("core.autocrlf", "false");
  const write = async (path: string, contents: string) => {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), contents, "utf8");
  };
  await write(
    "package.json",
    JSON.stringify({
      name: "demo",
      private: true,
      scripts: { test: "node check.cjs" },
    }),
  );
  await write("check.cjs", "process.exit(0);\n");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  await git.branch(["base"]);
  await git.checkoutLocalBranch("change");
  await write("check.cjs", changed);
  await git.add(["-A"]);
  await git.commit("change", ["--no-verify"]);
  return dir;
}

const judge = (dir: string, lines: string[]) =>
  runTier1({
    repoPath: dir,
    base: "base",
    checks: ["quality.tests.pass"],
    install: false,
    log: (line) => lines.push(line),
  });

describe("tier 1's test run on the change", () => {
  it("gets one more run when it fails on the change but passes at base, and a pass then is a flake", async () => {
    const lines: string[] = [];
    const result = await judge(await repo(FLAKY), lines);
    expect(lines).toContain(
      "tests failed on the change but pass at base: running them once more",
    );
    expect(result.verdict).toBe("pass");
    expect(result.notes).toContain(
      "tests failed on the change, then passed on one retry: flaky, not blamed on this change",
    );
    expect(result.testRun?.exitCode).toBe(0);
  }, 120_000);

  it("still fails a change whose tests fail twice", async () => {
    const lines: string[] = [];
    const result = await judge(await repo(BROKEN), lines);
    expect(result.verdict).toBe("fail");
    expect(
      result.checks.find((c) => c.id === "quality.tests.pass")?.outcome,
    ).toBe("fail");
    expect(result.testRun?.output).toContain("broken");
  }, 120_000);
});
