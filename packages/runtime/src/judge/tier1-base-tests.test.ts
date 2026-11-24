// Tier 1 runs a fix or feature card's new tests on the base: a file that
// passes there proves nothing about the change.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import type { Card } from "../task/card.js";
import { runTier1 } from "./tier1.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

// A stand-in for vitest: runs the files it's given as filters (or every
// *.test.js), exits 1 if any throws. Named so tier 1 knows how to run one
// file alone.
const RUNNER = `import { readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
const named = process.argv.slice(2).filter((a) => a.endsWith(".test.js"));
const files = named.length > 0
  ? named
  : readdirSync(".").filter((f) => f.endsWith(".test.js"));
let failed = 0;
for (const f of files) {
  try { await import(pathToFileURL(f).href); } catch (e) { failed++; console.log("FAIL " + f); }
}
process.exit(failed ? 1 : 0);
`;

const card = (type: Card["type"]): Card => ({
  id: "T-0001",
  title: "Make two() return 2",
  type,
  source: "prompt",
  description: "two() returns 1",
  acceptance: [
    {
      id: "A1",
      text: "New test two.test.js checks two() returns 2",
      verify: "unit",
    },
    {
      id: "A2",
      text: "New test one.test.js checks one() still returns 1",
      verify: "unit",
    },
  ],
  out_of_scope: [],
  touches: ["lib.js", "two.test.js", "one.test.js"],
  pages: [],
  constraints: [],
  risk: "low",
  owner: "someone@example.com",
  created: "2026-11-24",
});

async function repo(): Promise<{ path: string; base: string; head: string }> {
  const path = await mkdtemp(join(tmpdir(), "rivetari-t1base-"));
  dirs.push(path);
  const git = simpleGit(path);
  await git.init(["--quiet"]);
  await git.addConfig("commit.gpgsign", "false");
  await git.addConfig("user.name", "t");
  await git.addConfig("user.email", "t@example.com");
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({
      name: "x",
      type: "module",
      scripts: { test: "node vitest.mjs run" },
    }),
  );
  await writeFile(join(path, "vitest.mjs"), RUNNER);
  await writeFile(
    join(path, "lib.js"),
    "export const one = () => 1;\nexport const two = () => 1;\n",
  );
  await git.raw(["add", "-A"]);
  await git.raw(["commit", "--quiet", "-m", "base"]);
  const base = (await git.revparse(["HEAD"])).trim();
  await writeFile(
    join(path, "lib.js"),
    "export const one = () => 1;\nexport const two = () => 2;\n",
  );
  const check = (name: string, want: number) =>
    `import { ${name} } from "./lib.js";\nif (${name}() !== ${want}) throw new Error("${name}");\n`;
  await writeFile(join(path, "two.test.js"), check("two", 2));
  await writeFile(join(path, "one.test.js"), check("one", 1));
  await git.raw(["add", "-A"]);
  await git.raw(["commit", "--quiet", "-m", "head"]);
  return { path, base, head: (await git.revparse(["HEAD"])).trim() };
}

describe("tier 1 runs a card's new tests on the base", () => {
  it("finds the new test that passes on the base too", async () => {
    const r = await repo();
    const result = await runTier1({
      repoPath: r.path,
      base: r.base,
      head: r.head,
      checks: ["quality.tests.pass"],
      card: card("fix"),
      install: false,
    });
    expect(result.verdict).toBe("pass");
    expect(result.baseTests?.status).toBe("ran");
    expect(
      result.baseTests?.files.map((f) => [f.file, f.onBase]).sort(),
    ).toEqual([
      ["one.test.js", "pass"],
      ["two.test.js", "fail"],
    ]);
    expect(result.notes).toContain(
      "one.test.js passes on the base too: it proves nothing about this change",
    );
  });

  it("exempts a refactor card, and says so", async () => {
    const r = await repo();
    const result = await runTier1({
      repoPath: r.path,
      base: r.base,
      head: r.head,
      checks: ["quality.tests.pass"],
      card: card("refactor"),
      install: false,
    });
    expect(result.baseTests).toMatchObject({ status: "exempt", files: [] });
    expect(result.notes).toContain(
      "2 new test file(s) not run on the base: a refactor card is exempt (only fix and feature cards must show their tests fail without the change)",
    );
  });

  it("says the tests weren't run on the base when the tests check didn't run", async () => {
    const r = await repo();
    const result = await runTier1({
      repoPath: r.path,
      base: r.base,
      head: r.head,
      checks: [],
      recordedChecks: [
        {
          id: "quality.tests.pass",
          title: "Tests pass",
          base: "green",
          head: "green",
          outcome: "pass",
          message: "recorded",
        },
      ],
      card: card("feature"),
      install: false,
    });
    expect(result.baseTests?.status).toBe("not run");
    expect(result.baseTests?.files.map((f) => f.onBase)).toEqual([
      "not run",
      "not run",
    ]);
    expect(result.notes).toContain(
      "2 new test file(s) not run on the base: the tests check didn't run on the change",
    );
  });
});
