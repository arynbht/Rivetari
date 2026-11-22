import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { runTier1 } from "./tier1.js";
import {
  acquireWorkspace,
  dependencyKey,
  installedKey,
  setInstalledKey,
} from "./workspace.js";

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

async function repo() {
  const dir = await temp("factory-workspace-test-");
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
      { name: "demo", private: true, scripts: { test: 'node -e ""' } },
      null,
      2,
    ),
  );
  await write(".gitignore", "out/\nnode_modules/\n");
  await write("src/app.js", "module.exports = 1;\n");
  await commit("base");
  await git.branch(["base"]);
  await git.checkoutLocalBranch("change");
  await write("src/feature.js", "module.exports = 2;\n");
  await commit("feature");
  return { dir, write, commit };
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

describe("the judge's persistent workspace", () => {
  it("is reused across rounds: installed once, ignored leftovers cleaned, node_modules kept", async () => {
    const r = await repo();
    const root = await temp("factory-workspace-root-");
    const lines: string[] = [];
    const judge = () =>
      runTier1({
        repoPath: r.dir,
        base: "base",
        persistent: true,
        workspaceRoot: root,
        log: (line) => lines.push(line),
      });

    const first = await judge();
    expect(first.verdict).toBe("pass");
    expect(
      lines.some((l) => l.startsWith("cloning into the judge workspace")),
    ).toBe(true);
    expect(await installedKey(first.workDir)).toBe(
      await dependencyKey(first.workDir),
    );

    await mkdir(join(first.workDir, "node_modules", "dep"), {
      recursive: true,
    });
    await writeFile(join(first.workDir, "node_modules", "dep", "index.js"), "");
    await mkdir(join(first.workDir, "out"), { recursive: true });
    await writeFile(join(first.workDir, "out", "stale.js"), "");

    lines.length = 0;
    const second = await judge();
    expect(second.verdict).toBe("pass");
    expect(second.workDir).toBe(first.workDir);
    expect(lines).toContain(`reusing the judge workspace ${first.workDir}`);
    expect(lines).toContain(
      "dependencies unchanged since the last install: reusing them",
    );
    expect(
      await exists(join(second.workDir, "node_modules", "dep", "index.js")),
    ).toBe(true);
    expect(await exists(join(second.workDir, "out", "stale.js"))).toBe(false);
  }, 120_000);

  it("forgets the installed dependencies when the change touches a manifest", async () => {
    const r = await repo();
    const root = await temp("factory-workspace-root-");
    await r.write(
      "packages/a/package.json",
      JSON.stringify({ name: "a", version: "1.0.0" }),
    );
    await r.commit("a workspace package");
    const result = await runTier1({
      repoPath: r.dir,
      base: "base",
      persistent: true,
      workspaceRoot: root,
    });
    expect(result.verdict).toBe("pass");
    expect(await installedKey(result.workDir)).toBeNull();
  }, 120_000);

  it("keys the dependencies on the manifests, not on source files", async () => {
    const r = await repo();
    const before = await dependencyKey(r.dir);
    await r.write("src/other.js", "module.exports = 3;\n");
    expect(await dependencyKey(r.dir)).toBe(before);
    await r.write(
      "package.json",
      JSON.stringify({ name: "demo", private: true, dependencies: { x: "1" } }),
    );
    expect(await dependencyKey(r.dir)).not.toBe(before);
  }, 60_000);

  it("falls back to a fresh clone of its own while another judge holds the workspace", async () => {
    const r = await repo();
    const root = await temp("factory-workspace-root-");
    const held = await acquireWorkspace(r.dir, { root });
    expect(held).not.toBeNull();
    expect(await acquireWorkspace(r.dir, { root })).toBeNull();

    const lines: string[] = [];
    const result = await runTier1({
      repoPath: r.dir,
      base: "base",
      persistent: true,
      workspaceRoot: root,
      install: false,
      log: (line) => lines.push(line),
    });
    expect(result.verdict).toBe("pass");
    expect(result.workDir).not.toBe(held?.dir);
    expect(lines.some((l) => l.startsWith("cloning into "))).toBe(true);
    expect(await exists(result.workDir)).toBe(false);

    await held?.release();
    const again = await acquireWorkspace(r.dir, { root });
    expect(again?.dir).toBe(held?.dir);
    await again?.release();
  }, 120_000);

  it("takes over a lock a crashed judge left behind", async () => {
    const r = await repo();
    const root = await temp("factory-workspace-root-");
    const held = await acquireWorkspace(r.dir, { root });
    const later = Date.now() + 4 * 60 * 60_000;
    const taken = await acquireWorkspace(r.dir, { root, now: later });
    expect(taken?.dir).toBe(held?.dir);
    await taken?.release();
    await setInstalledKey(taken?.dir ?? "", null);
  }, 60_000);
});
