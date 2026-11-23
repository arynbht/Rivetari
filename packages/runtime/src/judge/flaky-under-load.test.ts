import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { failingTestFiles, runTier1 } from "./tier1.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const ESC = String.fromCharCode(27);

describe("failingTestFiles", () => {
  it("names the files vitest reports failing, once each", () => {
    const output = [
      " ✓ packages/a/src/ok.test.ts (3 tests) 20ms",
      " ❯ packages/runtime/src/task/store.test.ts (12 tests | 1 failed) 31002ms",
      "   × takes a lease 30001ms",
      " FAIL  packages/runtime/src/task/store.test.ts > lease > takes a lease",
      "Error: Test timed out in 30000ms.",
      " ❯ packages/runtime/src/task/store.test.ts:88:3",
      " FAIL  packages/cli/src/commands/task.test.ts [ packages/cli/src/commands/task.test.ts ]",
      " Test Files  2 failed | 1 passed (3)",
    ].join("\n");
    expect(failingTestFiles(output)).toEqual([
      "packages/runtime/src/task/store.test.ts",
      "packages/cli/src/commands/task.test.ts",
    ]);
  });

  it("reads Windows paths and coloured output", () => {
    const output = [
      `${ESC}[31m${ESC}[1m${ESC}[7m FAIL ${ESC}[27m${ESC}[22m${ESC}[39m packages\\runtime\\src\\judge\\tier1.test.ts${ESC}[2m > ${ESC}[22mjudges`,
      `${ESC}[31m❯${ESC}[39m packages\\engine\\src\\fix-pr.test.ts ${ESC}[2m(4 tests | ${ESC}[22m${ESC}[31m2 failed${ESC}[39m)`,
      "\r",
    ].join("\r\n");
    expect(failingTestFiles(output)).toEqual([
      "packages/runtime/src/judge/tier1.test.ts",
      "packages/engine/src/fix-pr.test.ts",
    ]);
  });

  it("reads the file past a workspace project's name", () => {
    const output = [
      ` ${ESC}[31m❯${ESC}[39m ${ESC}[33m|git|${ESC}[39m packages/runtime/src/task/store.test.ts (20 tests | 1 failed) 31002ms`,
      ` FAIL  ${ESC}[33m|git|${ESC}[39m packages/runtime/src/task/store.test.ts > lease > takes a lease`,
      " FAIL  |unit| packages/engine/src/paths.test.ts > paths > joins",
    ].join("\n");
    expect(failingTestFiles(output)).toEqual([
      "packages/runtime/src/task/store.test.ts",
      "packages/engine/src/paths.test.ts",
    ]);
  });

  it("names nothing in output that isn't vitest's", () => {
    expect(failingTestFiles("")).toEqual([]);
    expect(failingTestFiles("broken\nnpm ERR! Test failed.\n")).toEqual([]);
    expect(
      failingTestFiles(" ✓ packages/a/src/ok.test.ts (3 tests) 20ms\n"),
    ).toEqual([]);
  });
});

interface Suite {
  files: string[];
  failInSuite: string[];
  failAlone: string[];
  coverage?: boolean;
}

const standIn = (suite: Suite, log: string) => `const fs = require("fs");
const path = require("path");
const suite = ${JSON.stringify(suite)};
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
const files = args.filter((a) => !a.startsWith("--"));
if (suite.coverage && !args.includes("--coverage.enabled=false")) {
  fs.mkdirSync("coverage", { recursive: true });
  fs.writeFileSync(
    path.join("coverage", "coverage-summary.json"),
    JSON.stringify({ total: { lines: { pct: 80 } } }),
  );
}
if (files.length === 0) {
  const failed = suite.files.filter((f) => suite.failInSuite.includes(f));
  for (const f of suite.files)
    console.log(failed.includes(f) ? " FAIL  " + f + " > works" : " ✓ " + f + " (1 test)");
  if (failed.length > 0) console.log("Error: Test timed out in 30000ms.");
  console.log(" Test Files  " + failed.length + " failed | " + (suite.files.length - failed.length) + " passed");
  process.exit(failed.length > 0 ? 1 : 0);
}
const failed = files.filter((f) => suite.failAlone.includes(f));
for (const f of files)
  console.log(failed.includes(f) ? " FAIL  " + f + " > works alone" : " ✓ " + f + " (1 test)");
process.exit(failed.length > 0 ? 1 : 0);
`;

async function repo(suite: Suite) {
  const dir = await mkdtemp(join(tmpdir(), "factory-under-load-test-"));
  made.push(dir);
  const log = join(dir, "..", `${dir.split(/[\\/]/).pop() ?? "x"}.runs.log`);
  made.push(log);
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
  await write(
    "check.cjs",
    suite.coverage
      ? `const fs = require("fs");
fs.mkdirSync("coverage", { recursive: true });
fs.writeFileSync("coverage/coverage-summary.json", JSON.stringify({ total: { lines: { pct: 80 } } }));
`
      : "process.exit(0);\n",
  );
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  await git.branch(["base"]);
  await git.checkoutLocalBranch("change");
  await write("check.cjs", standIn(suite, log));
  await git.add(["-A"]);
  await git.commit("change", ["--no-verify"]);
  return { dir, log };
}

const runs = async (log: string) =>
  (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);

const A = "src/a.test.ts";
const B = "src/b.test.ts";

describe("tier 1 on a test file that fails under the full suite", () => {
  it("passes tests.pass when the file passes alone, and notes it as flaky under load (A1)", async () => {
    const { dir } = await repo({
      files: [A],
      failInSuite: [A],
      failAlone: [],
    });
    const lines: string[] = [];
    const result = await runTier1({
      repoPath: dir,
      base: "base",
      checks: ["quality.tests.pass"],
      install: false,
      log: (line) => lines.push(line),
    });
    expect(result.verdict).toBe("pass");
    expect(
      result.checks.find((c) => c.id === "quality.tests.pass")?.outcome,
    ).toBe("pass");
    expect(result.notes).toContain(
      `${A}: failed in the full suite, passed alone: flaky under load, not blamed on this change`,
    );
    expect(lines).toContain(
      `${A} failed in the full suite: running it again, alone`,
    );
  }, 120_000);

  it("fails tests.pass and keeps the failing output when the file fails alone too (A2)", async () => {
    const { dir } = await repo({
      files: [A],
      failInSuite: [A],
      failAlone: [A],
    });
    const result = await runTier1({
      repoPath: dir,
      base: "base",
      checks: ["quality.tests.pass"],
      install: false,
    });
    expect(result.verdict).toBe("fail");
    expect(
      result.checks.find((c) => c.id === "quality.tests.pass")?.outcome,
    ).toBe("fail");
    expect(result.testRun?.exitCode).toBe(1);
    expect(result.testRun?.output).toContain(` FAIL  ${A} > works`);
    expect(result.testRun?.output).toContain(` FAIL  ${A} > works alone`);
    expect(result.notes).toContain(
      `${A}: failed in the full suite and again alone: a real failure`,
    );
    expect(result.notes.join("\n")).not.toContain("flaky");
  }, 120_000);

  it("re-runs only the failing files, one at a time, never the whole suite (A3)", async () => {
    const { dir, log } = await repo({
      files: [A, B],
      failInSuite: [A],
      failAlone: [],
    });
    const lines: string[] = [];
    await runTier1({
      repoPath: dir,
      base: "base",
      checks: ["quality.tests.pass"],
      install: false,
      log: (line) => lines.push(line),
    });
    const calls = await runs(log);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.filter((a) => !a.startsWith("--"))).toEqual([]);
    expect(calls[1]?.filter((a) => !a.startsWith("--"))).toEqual([A]);
    expect(calls[1]).toContain("--coverage.enabled=false");
    expect(lines).not.toContain(
      "tests failed on the change but pass at base: running them once more",
    );
  }, 120_000);

  it("re-runs two failing files separately, and fails if either fails alone", async () => {
    const { dir, log } = await repo({
      files: [A, B],
      failInSuite: [A, B],
      failAlone: [B],
    });
    const result = await runTier1({
      repoPath: dir,
      base: "base",
      checks: ["quality.tests.pass"],
      install: false,
    });
    const calls = (await runs(log)).map((c) =>
      c.filter((a) => !a.startsWith("--")),
    );
    expect(calls).toEqual([[], [A], [B]]);
    expect(result.verdict).toBe("fail");
    expect(result.notes).toContain(
      `${B}: failed in the full suite and again alone: a real failure`,
    );
  }, 120_000);
});

describe("coverage when a test fails (A4)", () => {
  it("is written by the repo's vitest config even when a test fails", async () => {
    const path = fileURLToPath(
      new URL("../../../../vitest.config.ts", import.meta.url),
    );
    const config = (await import(path)) as {
      default: {
        test?: {
          coverage?: { enabled?: boolean; reportOnFailure?: boolean };
        };
      };
    };
    expect(config.default.test?.coverage?.enabled).toBe(true);
    expect(config.default.test?.coverage?.reportOnFailure).toBe(true);
  });

  it("is checked against the full run's summary after a failing test, and the re-run leaves it in place", async () => {
    const { dir } = await repo({
      files: [A],
      failInSuite: [A],
      failAlone: [A],
      coverage: true,
    });
    const result = await runTier1({
      repoPath: dir,
      base: "base",
      checks: ["quality.tests.pass", "quality.coverage.floor"],
      install: false,
      keep: true,
    });
    made.push(result.workDir);
    const coverage = result.checks.find(
      (c) => c.id === "quality.coverage.floor",
    );
    expect(coverage?.head).toBe("green");
    expect(coverage?.message).not.toContain("wrote no");
    expect(coverage?.message).toContain("80%");
    await expect(
      access(join(result.workDir, "coverage", "coverage-summary.json")),
    ).resolves.toBeUndefined();
    expect(
      result.checks.find((c) => c.id === "quality.tests.pass")?.outcome,
    ).toBe("fail");
  }, 120_000);
});
