import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { failingTestFiles, failureBeyondFiles, runTier1 } from "./tier1.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};

const SUMMARY = JSON.stringify({ total: { lines: { pct: 80 } } });

const BASE = `const fs = require("fs");
fs.mkdirSync("coverage", { recursive: true });
fs.writeFileSync("coverage/coverage-summary.json", ${JSON.stringify(SUMMARY)});
`;

function change(calls: string, failAlone: string[], extra: string[]) {
  return `const fs = require("fs");
const calls = ${JSON.stringify(calls)};
const file = process.argv[2];
if (!file) {
  fs.appendFileSync(calls, "suite\\n");
  fs.mkdirSync("coverage", { recursive: true });
  fs.writeFileSync("coverage/coverage-summary.json", ${JSON.stringify(SUMMARY)});
  console.log(" FAIL  src/a.test.ts > a > works under load");
  console.log(" FAIL  src/b.test.ts > b > works under load");
  console.log(" FAIL  src/a.test.ts > a > works again");
  for (const line of ${JSON.stringify(extra)}) console.log(line);
  process.exit(1);
}
fs.appendFileSync(calls, "start " + file + " " + process.argv.slice(3).join(" ") + "\\n");
const failAlone = ${JSON.stringify(failAlone)};
setTimeout(() => {
  fs.appendFileSync(calls, "end " + file + "\\n");
  if (fs.existsSync("coverage/coverage-summary.json")) fs.appendFileSync(calls, "summary kept\\n");
  if (failAlone.includes(file)) {
    console.error("still broken alone: " + file);
    process.exit(1);
  }
}, 200);
`;
}

async function repo(failAlone: string[], extra: string[] = []) {
  const dir = await tmp("rivetari-under-load-");
  const calls = join(await tmp("rivetari-under-load-calls-"), "calls.log");
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
    ".rivetari/quality.json",
    JSON.stringify({ coverage: { lines: 50, recorded: "2026-11-01" } }),
  );
  await write("check.cjs", BASE);
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  await git.branch(["base"]);
  await git.checkoutLocalBranch("change");
  await write("check.cjs", change(calls, failAlone, extra));
  await git.add(["-A"]);
  await git.commit("change", ["--no-verify"]);
  return { dir, calls };
}

const judge = (dir: string, checks = ["quality.tests.pass"]) =>
  runTier1({ repoPath: dir, base: "base", checks, install: false });

const callsIn = async (path: string) =>
  (await readFile(path, "utf8")).trim().split("\n");

const testsPass = (result: Awaited<ReturnType<typeof judge>>) =>
  result.checks.find((c) => c.id === "quality.tests.pass");

describe("tier 1 re-runs a change's failing test files alone", () => {
  it("passes tests.pass and records each file that passes alone as flaky under load", async () => {
    const { dir } = await repo([]);
    const result = await judge(dir);
    expect(result.verdict).toBe("pass");
    expect(testsPass(result)?.outcome).toBe("pass");
    expect(result.notes).toEqual([
      "src/a.test.ts failed in the full run but passed alone: flaky under load, not blamed on this change",
      "src/b.test.ts failed in the full run but passed alone: flaky under load, not blamed on this change",
    ]);
  }, 120_000);

  it("fails tests.pass and keeps the failing output when a file also fails alone", async () => {
    const { dir } = await repo(["src/b.test.ts"]);
    const result = await judge(dir);
    expect(result.verdict).toBe("fail");
    expect(testsPass(result)?.outcome).toBe("fail");
    expect(result.testRun?.exitCode).toBe(1);
    expect(result.testRun?.output).toContain(
      "FAIL  src/b.test.ts > b > works under load",
    );
    expect(result.testRun?.output).toContain(
      "still broken alone: src/b.test.ts",
    );
    expect(result.notes).toContain(
      "src/b.test.ts failed in the full run and again alone",
    );
  }, 120_000);

  it("re-runs only the failing files, one at a time, never the whole suite", async () => {
    const { dir, calls } = await repo([]);
    await judge(dir);
    expect(await callsIn(calls)).toEqual([
      "suite",
      "start src/a.test.ts --coverage.enabled=false",
      "end src/a.test.ts",
      "summary kept",
      "start src/b.test.ts --coverage.enabled=false",
      "end src/b.test.ts",
      "summary kept",
    ]);
  }, 120_000);

  it("judges coverage on the summary the failing full run wrote", async () => {
    const { dir, calls } = await repo([]);
    const result = await judge(dir, [
      "quality.tests.pass",
      "quality.coverage.floor",
    ]);
    const coverage = result.checks.find(
      (c) => c.id === "quality.coverage.floor",
    );
    expect(coverage?.head).toBe("green");
    expect(coverage?.message).toContain("80% lines ≥ floor 50%");
    expect(await callsIn(calls)).toContain("summary kept");
    expect(result.verdict).toBe("pass");
  }, 120_000);

  it("re-runs nothing and keeps tests.pass failed when the run also reports unhandled errors", async () => {
    const { dir, calls } = await repo(
      [],
      [
        "⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯",
        "Unhandled Rejection",
        "      Errors  1 error",
      ],
    );
    const result = await judge(dir);
    expect(result.verdict).toBe("fail");
    expect(testsPass(result)?.outcome).toBe("fail");
    expect(await callsIn(calls)).toEqual(["suite"]);
    expect(result.testRun?.output).toContain("Unhandled Rejection");
    expect(result.notes).toEqual([
      "src/a.test.ts, src/b.test.ts failed in the full run, which also reported unhandled errors: the named files don't account for every failure, so none were re-run alone",
    ]);
  }, 120_000);

  it("re-runs nothing when the run also misses a coverage threshold", async () => {
    const { dir, calls } = await repo(
      [],
      ["ERROR: Coverage for lines (40%) does not meet global threshold (50%)"],
    );
    const result = await judge(dir);
    expect(testsPass(result)?.outcome).toBe("fail");
    expect(await callsIn(calls)).toEqual(["suite"]);
    expect(result.notes[0]).toContain("a coverage threshold miss");
  }, 120_000);
});

describe("the repo's vitest config", () => {
  it("writes the coverage summary even when a test fails", async () => {
    const path = fileURLToPath(
      new URL("../../../../vitest.config.ts", import.meta.url),
    );
    const config = (
      (await import(pathToFileURL(path).href)) as {
        default: {
          test?: {
            coverage?: { enabled?: boolean; reportOnFailure?: boolean };
            poolOptions?: { forks?: { singleFork?: boolean } };
          };
        };
      }
    ).default;
    expect(config.test?.coverage?.enabled).toBe(true);
    expect(config.test?.coverage?.reportOnFailure).toBe(true);
    expect(config.test?.poolOptions?.forks?.singleFork).toBe(true);
  });
});

describe("failingTestFiles", () => {
  it("reads vitest's FAIL lines through its colours, each file once, in order", () => {
    const output = [
      "\u001b[41m\u001b[1m FAIL \u001b[22m\u001b[49m packages/x/b.test.ts\u001b[2m > \u001b[22mworks",
      " FAIL  packages/x/a.test.ts [ packages/x/a.test.ts ]",
      " FAIL  packages/x/b.test.ts > works again",
      " ✓ packages/x/c.test.ts (3 tests) 12ms",
    ].join("\r\n");
    expect(failingTestFiles(output)).toEqual([
      "packages/x/b.test.ts",
      "packages/x/a.test.ts",
    ]);
  });

  it("finds nothing in output that names no failing file", () => {
    expect(failingTestFiles("broken\nnpm ERR! Test failed.")).toEqual([]);
  });
});

describe("failureBeyondFiles", () => {
  it("names failures vitest reports outside any test file", () => {
    const output = [
      "\u001b[31m⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯\u001b[39m",
      "\u001b[2m      Errors \u001b[22m 2 errors",
      "⎯⎯⎯ Type Errors 1 ⎯⎯⎯",
      "ERROR: Coverage for lines (40%) does not meet global threshold (50%)",
    ].join("\r\n");
    expect(failureBeyondFiles(output)).toEqual([
      "unhandled errors",
      "type errors",
      "a coverage threshold miss",
    ]);
  });

  it("finds nothing when only test files failed", () => {
    const output = [
      " FAIL  packages/x/a.test.ts > works",
      " Test Files  1 failed | 3 passed (4)",
      "      Tests  1 failed | 20 passed (21)",
    ].join("\n");
    expect(failureBeyondFiles(output)).toEqual([]);
  });
});
