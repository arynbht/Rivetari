import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { workspaceScope } from "./workspace.js";

// CI's scripts/ci-scope.mjs has to pick the same packages as the judge's
// affected-only tier 1, so each case runs both on the same repo.
const script = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../scripts/ci-scope.mjs",
);

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

const pkg = (name: string, deps: string[] = []) =>
  JSON.stringify({
    name,
    dependencies: Object.fromEntries(deps.map((d) => [d, "workspace:*"])),
  });

async function repo(change: Record<string, string | null>, moves = {}) {
  const dir = await mkdtemp(join(tmpdir(), "ci-scope-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "pnpm-workspace.yaml": 'packages:\n  - "packages/*"\n',
    "package.json": JSON.stringify({ name: "root", private: true }),
    "tsconfig.json": JSON.stringify({
      files: [],
      references: [
        { path: "packages/a" },
        { path: "packages/b" },
        { path: "packages/c" },
        { path: "packages/d" },
      ],
    }),
    "README.md": "# root\n",
    "packages/a/package.json": pkg("a"),
    "packages/a/src/x.ts": "export const x = 1;\n",
    "packages/b/package.json": pkg("b", ["a"]),
    "packages/b/src/y.ts": "export const y = 1;\n",
    "packages/c/package.json": pkg("c"),
    "packages/c/src/z.ts": "export const z = 1;\n",
    "packages/d/package.json": pkg("d"),
    "packages/d/src/w.ts": "export const w = 1;\n",
  };
  const write = async (path: string, text: string) => {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), text, "utf8");
  };
  for (const [path, text] of Object.entries(files)) await write(path, text);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await git.addConfig("core.autocrlf", "false");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  for (const [path, text] of Object.entries(change)) {
    if (text === null) await rm(join(dir, path));
    else await write(path, text);
  }
  for (const [from, to] of Object.entries(moves))
    await git.raw(["mv", from, to as string]);
  await git.add(["-A"]);
  await git.commit("change", ["--no-verify"]);
  return { dir, git };
}

function ciScope(dir: string) {
  const out = execFileSync("node", [script, "HEAD~1"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: "" },
  });
  return Object.fromEntries(
    out
      .split("\n")
      .filter((l) => /^\w+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

async function judgeScope(dir: string) {
  const git = simpleGit(dir);
  const paths = (
    await git.raw(["diff", "--name-only", "--no-renames", "HEAD~1", "HEAD"])
  )
    .split("\n")
    .filter(Boolean);
  return workspaceScope(git, ["HEAD~1", "HEAD"], paths);
}

describe("scripts/ci-scope.mjs", () => {
  it("scopes to the touched package and its dependents, as the judge does", async () => {
    const { dir } = await repo({
      "packages/a/src/x.ts": "export const x = 2;\n",
    });
    const ci = ciScope(dir);
    const judge = await judgeScope(dir);
    expect(ci["all"]).toBe("false");
    expect(ci["dirs"]).toBe("packages/a packages/b");
    expect(judge?.kind === "packages" && [...judge.dirs].sort().join(" ")).toBe(
      ci["dirs"],
    );
    expect(ci["tsconfigs"]).toBe(
      "packages/a/tsconfig.json packages/b/tsconfig.json",
    );
  });

  it("checks nothing for a docs-only diff", async () => {
    const { dir } = await repo({
      "README.md": "# changed\n",
      "docs/guide.md": "hi\n",
      ".changeset/x.md": "---\n---\n",
    });
    expect(ciScope(dir)).toMatchObject({ all: "false", none: "true" });
  });

  it("checks everything when a root file changes, as the judge does", async () => {
    const { dir } = await repo({ "pnpm-lock.yaml": "lockfileVersion: 9\n" });
    expect(ciScope(dir)).toMatchObject({
      all: "true",
      tsconfigs: "tsconfig.json",
    });
    expect((await judgeScope(dir))?.kind).toBe("all");
  });

  it("keeps the package a file moved out of in scope", async () => {
    const { dir } = await repo(
      {},
      { "packages/c/src/z.ts": "packages/a/src/z.ts" },
    );
    expect(ciScope(dir)["dirs"]).toBe("packages/a packages/b packages/c");
  });
});
