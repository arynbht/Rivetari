import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CardError } from "./card.js";
import { newTask } from "./tasks.js";
import { checkTouches, TOUCHES_CAP } from "./touches.js";

const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
let repo: string;
const savedConfig = process.env.RIVETARI_CONFIG_DIR;

async function seed(dir: string): Promise<void> {
  const files = [
    ...Array.from({ length: 25 }, (_, i) => `packages/a/t${i}.test.ts`),
    ...Array.from({ length: 20 }, (_, i) => `packages/b/f${i}.ts`),
    "packages/c/one.ts",
    "packages/c/two.ts",
    "packages/c/three.ts",
    "README.md",
  ];
  for (const f of files) {
    await mkdir(join(dir, f, ".."), { recursive: true });
    await writeFile(join(dir, f), "x\n");
  }
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
}

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
  repo = await tmp("rivetari-touches-");
  await seed(repo);
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const CARD = {
  title: "Tidy the tests",
  type: "chore" as const,
  description: "Tidy up the tests.",
  acceptance: [{ id: "A1", text: "Tests pass", verify: "unit" as const }],
};
const by = { by: "dev@example.com", now: new Date("2026-11-23T10:00:00Z") };

describe("the touches cap at intake", () => {
  it("refuses a glob matching more than the cap, naming it, its count and some files", async () => {
    expect(TOUCHES_CAP).toBe(20);
    const err = await checkTouches(repo, ["packages/**/*.test.ts"]).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CardError);
    const issues = (err as CardError).issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("packages/**/*.test.ts");
    expect(issues[0]).toContain("matches 25 tracked files");
    expect(issues[0]).toContain("packages/a/t0.test.ts");
    expect(issues[0]).toContain("and 20 more");
    expect(issues[0]).toContain("name the files the task changes");
    expect(issues[0]).toContain("narrow the glob");
  });

  it("refuses the card in newTask and writes nothing for it", async () => {
    const err = await newTask(
      repo,
      { ...CARD, touches: ["README.md", "packages/**"] },
      by,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CardError);
    expect((err as CardError).message).toContain("packages/**");
    expect((err as CardError).message).toContain("matches 48 tracked files");
    await expect(access(join(repo, ".rivetari/tasks"))).rejects.toThrow();
  });

  it("accepts a plain path, a narrow glob, a glob at the cap and a glob matching nothing", async () => {
    const touches = [
      "packages/a/t0.test.ts",
      "packages/c/*.ts",
      "packages/b/**",
      "packages/new/**/*.ts",
    ];
    await expect(checkTouches(repo, touches)).resolves.toBeUndefined();
    const task = await newTask(repo, { ...CARD, touches }, by);
    expect(task.card.touches).toEqual(touches);
  });

  it("accepts any glob in a folder that isn't a git repo", async () => {
    const plain = await tmp("rivetari-plain-");
    await expect(checkTouches(plain, ["**"])).resolves.toBeUndefined();
  });
});
