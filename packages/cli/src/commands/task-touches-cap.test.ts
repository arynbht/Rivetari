import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stringify } from "yaml";

import { runTaskNew } from "./task.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const IDENTITY = {
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
};

let out: string[];
let err: string[];
beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(console, "error").mockImplementation((s: unknown) => {
    err.push(String(s));
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function clone(): Promise<string> {
  const origin = await tmp("rivetari-origin-");
  git(origin, "init", "--bare", "-b", "main");
  const seed = await tmp("rivetari-seed-");
  git(seed, "init", "-b", "main");
  git(seed, "config", "core.autocrlf", "false");
  for (let i = 0; i < 25; i++) {
    const dir = join(seed, "packages", i < 15 ? "a" : "b", "src");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `t${i}.test.ts`), "x\n");
  }
  await writeFile(join(seed, "README.md"), "# demo\n");
  git(seed, "add", "-A");
  execFileSync("git", ["-C", seed, "commit", "-q", "-m", "base"], {
    env: { ...process.env, ...IDENTITY },
  });
  git(seed, "push", "-q", origin, "main");
  const dir = await tmp("rivetari-clone-");
  git(dir, "clone", "-q", origin, ".");
  git(dir, "config", "user.email", "ann@team");
  await writeFile(join(dir, ".gitignore"), ".rivetari/tasks/\n");
  return dir;
}

const CARD = {
  title: "Tidy the tests",
  type: "chore",
  description: "Tidy up the tests.",
  accept: ["tests pass::unit"],
};

describe("rivetari task new, with a touches glob over the cap", () => {
  it("refuses --touches 'packages/**/*.test.ts' before reserving an id", async () => {
    const repo = await clone();
    expect(
      await runTaskNew(CARD.title, {
        ...CARD,
        touches: ["packages/**/*.test.ts"],
        path: repo,
      }),
    ).toBe(1);
    const message = err.join("\n");
    expect(message).toContain("packages/**/*.test.ts");
    expect(message).toContain("matches 25 tracked files");
    expect(message).toContain("name the files the task changes");
    expect(message).toContain("narrow the glob");
    expect(git(repo, "branch", "--list", "rivetari/tasks")).toBe("");
    expect(out.join("")).not.toContain("drafted");
  }, 60_000);

  it("gives a card from --from YAML the same check", async () => {
    const repo = await clone();
    const from = join(await tmp("rivetari-card-"), "card.yml");
    await writeFile(
      from,
      stringify({
        title: CARD.title,
        type: "chore",
        description: CARD.description,
        acceptance: [{ id: "A1", text: "tests pass", verify: "unit" }],
        touches: ["README.md", "packages/**/*.test.ts"],
      }),
    );
    expect(await runTaskNew(undefined, { from, path: repo })).toBe(1);
    const message = err.join("\n");
    expect(message).toContain("packages/**/*.test.ts");
    expect(message).toContain("matches 25 tracked files");
    expect(git(repo, "branch", "--list", "rivetari/tasks")).toBe("");
  }, 60_000);

  it("drafts a card naming a plain path, a narrow glob and a glob for new files", async () => {
    const repo = await clone();
    const cases = [
      ["packages/a/src/t0.test.ts"],
      ["packages/b/**/*.test.ts"],
      ["packages/c/**/*.ts"],
    ];
    for (const [i, touches] of cases.entries()) {
      expect(
        await runTaskNew(CARD.title, { ...CARD, touches, path: repo }),
        err.join(" | "),
      ).toBe(0);
      expect(out.join("")).toContain(`drafted T-000${i + 1}`);
    }
  }, 120_000);
});
