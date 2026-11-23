// Tier 1 checks only the workspace packages a change can affect: the packages
// it touches and every package that depends on them.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { changeChecks, narrowScript, runTier1, scopeChecks } from "./tier1.js";
import { affectedScope, type WorkspaceGraph } from "./workspace.js";

// This repo's own graph, as its package.json files declare it.
const GRAPH: WorkspaceGraph = {
  rootDeps: ["vitest", "typescript"],
  packages: [
    { dir: "packages/catalog", name: "@r/catalog", deps: ["zod"] },
    { dir: "packages/engine", name: "@r/engine", deps: ["@r/catalog"] },
    { dir: "packages/registry", name: "@r/registry", deps: ["@r/engine"] },
    {
      dir: "packages/runtime",
      name: "@r/runtime",
      deps: ["@r/catalog", "@r/engine", "@r/registry"],
    },
    {
      dir: "packages/cli",
      name: "@r/cli",
      deps: ["@r/catalog", "@r/engine", "@r/registry", "@r/runtime"],
    },
    { dir: "packages/action", name: "@r/action", deps: ["@r/cli"] },
    {
      dir: "apps/desktop",
      name: "@r/desktop",
      deps: ["@r/catalog", "@r/engine"],
    },
  ],
};

const SCRIPTS = {
  lint: "eslint .",
  typecheck: "tsc --build",
  boundaries: "depcruise packages apps --config .dependency-cruiser.mjs",
  test: "tsc --build && vitest run",
};

describe("affectedScope", () => {
  it("scopes a registry change to registry and the packages that depend on it", () => {
    expect(affectedScope(["packages/registry/src/skills.ts"], GRAPH)).toEqual({
      kind: "packages",
      dirs: [
        "packages/registry",
        "packages/action",
        "packages/cli",
        "packages/runtime",
      ],
      touched: ["packages/registry"],
      dependents: ["packages/action", "packages/cli", "packages/runtime"],
    });
  });

  it("checks everything for a change outside every package", () => {
    for (const path of [
      "vitest.config.ts",
      "pnpm-lock.yaml",
      "tsconfig.base.json",
      "scripts/build-action.mjs",
    ])
      expect(
        affectedScope(["packages/registry/src/skills.ts", path], GRAPH),
      ).toEqual({
        kind: "all",
        why: `${path} is outside every workspace package`,
      });
  });

  it("checks everything when the root package depends on an affected one", () => {
    const scope = affectedScope(["packages/catalog/src/a.ts"], {
      ...GRAPH,
      rootDeps: ["@r/action"],
    });
    expect(scope.kind).toBe("all");
  });

  it("doesn't take a package for one whose name it starts with", () => {
    const scope = affectedScope(["packages/cli-extra/src/a.ts"], GRAPH);
    expect(scope).toEqual({
      kind: "all",
      why: "packages/cli-extra/src/a.ts is outside every workspace package",
    });
  });
});

describe("narrowScript", () => {
  const dirs = ["packages/registry", "packages/cli"];

  it("passes the packages to vitest or jest as path filters, coverage off", () => {
    expect(narrowScript("npm test", "tsc --build && vitest run", dirs)).toBe(
      "npm test -- packages/registry/ packages/cli/ --passWithNoTests --coverage.enabled=false",
    );
    expect(narrowScript("npm run test:unit", "jest --ci", dirs)).toBe(
      "npm run test:unit -- packages/registry/ packages/cli/ --passWithNoTests --coverage=false",
    );
  });

  it("filters a recursive pnpm run to the packages", () => {
    expect(narrowScript("npm test", "pnpm -r test", dirs)).toBe(
      "pnpm --filter=./packages/registry --filter=./packages/cli run --if-present test",
    );
    expect(narrowScript("npm run lint", "pnpm -r run lint", dirs)).toBe(
      "pnpm --filter=./packages/registry --filter=./packages/cli run --if-present lint",
    );
  });

  it("leaves a script it can't narrow alone", () => {
    for (const script of [
      "eslint .",
      "tsc --build",
      "vitest run | tee out.txt",
      "vitest run; echo done",
      "vitest --watch",
      "pnpm -r install",
      "node test.cjs",
    ])
      expect(narrowScript("npm test", script, dirs)).toBeNull();
    expect(narrowScript("npm test", "vitest run", ["my pkg"])).toBeNull();
  });
});

describe("scopeChecks", () => {
  it("narrows the test run, runs the rest in full and drops the coverage floor", async () => {
    const checks = await changeChecks();
    const scope = affectedScope(["packages/registry/src/skills.ts"], GRAPH);
    const { controls, notes } = scopeChecks(checks, scope, SCRIPTS);
    const tests = controls.find((c) => c.id === "quality.tests.pass");
    expect(tests?.detect[0]).toMatchObject({
      byStack: {
        node: "npm test -- packages/registry/ packages/action/ packages/cli/ packages/runtime/ --passWithNoTests --coverage.enabled=false",
      },
    });
    expect(controls.map((c) => c.id)).not.toContain("quality.coverage.floor");
    const lint = controls.find((c) => c.id === "quality.lint.clean");
    expect(lint).toEqual(checks.find((c) => c.id === "quality.lint.clean"));
    expect(notes[0]).toBe(
      "checked packages/registry, packages/action, packages/cli, packages/runtime only: the change touches packages/registry, and packages/action, packages/cli, packages/runtime depend on it",
    );
    expect(notes.join("\n")).toContain("quality.lint.clean");
    expect(notes.join("\n")).toContain("quality.coverage.floor not checked");
  });

  it("keeps every check, coverage too, when the scope is everything", async () => {
    const checks = await changeChecks();
    const { controls, notes } = scopeChecks(
      checks,
      {
        kind: "all",
        why: "vitest.config.ts is outside every workspace package",
      },
      SCRIPTS,
    );
    expect(controls).toEqual(checks);
    expect(notes).toEqual([
      "checked every workspace package: vitest.config.ts is outside every workspace package",
    ]);
  });

  it("says nothing outside a pnpm workspace", async () => {
    const checks = await changeChecks();
    expect(scopeChecks(checks, null, SCRIPTS)).toEqual({
      controls: checks,
      notes: [],
    });
  });
});

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repo(workspace: boolean) {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-scope-test-"));
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
  const commit = async (msg: string) => {
    await git.add(["-A"]);
    await git.commit(msg, ["--no-verify"]);
  };
  await write(
    "package.json",
    JSON.stringify({
      name: "demo",
      private: true,
      scripts: { test: workspace ? "pnpm -r test" : 'node -e ""' },
    }),
  );
  if (workspace)
    await write("pnpm-workspace.yaml", "packages:\n  - packages/*\n");
  const pkg = (name: string, deps: Record<string, string> = {}) =>
    JSON.stringify({
      name,
      private: true,
      scripts: { test: `node -e "console.log('tested ${name}')"` },
      dependencies: deps,
    });
  await write("packages/a/package.json", pkg("a"));
  await write("packages/b/package.json", pkg("b", { a: "workspace:*" }));
  await write("packages/c/package.json", pkg("c"));
  await write("packages/a/index.js", "module.exports = 1;\n");
  await commit("base");
  await git.branch(["base"]);
  await git.checkoutLocalBranch("change");
  return { dir, write, commit };
}

const judge = (dir: string, checks: string[]) =>
  runTier1({ repoPath: dir, base: "base", checks, install: false });

describe("tier 1 in a pnpm workspace", () => {
  it("runs the tests of the touched package and its dependents only", async () => {
    const r = await repo(true);
    await r.write("packages/a/index.js", "module.exports = 2;\n");
    await r.commit("change a");
    const result = await judge(r.dir, [
      "quality.tests.pass",
      "quality.coverage.floor",
    ]);
    expect(result.testRun?.command).toBe(
      "pnpm --filter=./packages/a --filter=./packages/b run --if-present test",
    );
    expect(result.testRun?.output).toContain("tested a");
    expect(result.testRun?.output).toContain("tested b");
    expect(result.testRun?.output).not.toContain("tested c");
    expect(result.checks.map((c) => c.id)).not.toContain(
      "quality.coverage.floor",
    );
    expect(result.notes).toContain(
      "checked packages/a, packages/b only: the change touches packages/a, and packages/b depends on it",
    );
    expect(result.verdict).toBe("pass");
  }, 120_000);

  it("runs everything for a root config change", async () => {
    const r = await repo(true);
    await r.write("vitest.config.ts", "export default {};\n");
    await r.commit("root config");
    const result = await judge(r.dir, ["quality.tests.pass"]);
    expect(result.testRun?.command).toBe("npm test");
    expect(result.testRun?.output).toContain("tested c");
    expect(result.notes).toContain(
      "checked every workspace package: vitest.config.ts is outside every workspace package",
    );
  }, 120_000);

  it("runs everything, without a scope note, outside a pnpm workspace", async () => {
    const r = await repo(false);
    await r.write("packages/a/index.js", "module.exports = 2;\n");
    await r.commit("change a");
    const result = await judge(r.dir, ["quality.tests.pass"]);
    expect(result.testRun?.command).toBe("npm test");
    expect(result.notes).toEqual([]);
    expect(result.verdict).toBe("pass");
  }, 120_000);
});
