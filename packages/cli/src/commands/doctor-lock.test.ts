// Doctor on a lock that matches its install but routes nothing: the pilot's
// spine-only lock left every task without sector skills while doctor said
// "installed skills match the lock" (R-17).
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AGENTS_SKILLS,
  hashSkillDir,
  lockDigest,
} from "@arynbht/rivetari-registry";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { doctorChecks } from "./doctor.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const PIN = "a".repeat(40);

/**
 * A web app whose lock holds one installed spine skill, plus `extra` task
 * skills, synced: the skills check has nothing to fail on.
 */
async function webApp(
  extra: string[],
  profile = "version: 1\n",
): Promise<string> {
  const repo = await tmp("rivetari-doctor-lock-");
  git(repo, "init", "-b", "main");
  const files: Record<string, string> = {
    ".rivetari/profile.yml": profile,
    "src/app/page.tsx": "export default function Page() { return null; }\n",
    "src/app/globals.css": "body { margin: 0; }\n",
    [`${AGENTS_SKILLS}/test-driven-development/SKILL.md`]: "# tdd\n",
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  const hash = await hashSkillDir(
    join(repo, AGENTS_SKILLS, "test-driven-development"),
  );
  const entry = (name: string, scope: string, h = `sha256:${"b".repeat(64)}`) =>
    [
      `  - name: ${name}`,
      `    source: example/skills/${name}`,
      `    pin: ${PIN}`,
      `    hash: "${h}"`,
      `    scope: ${scope}`,
    ].join("\n");
  await writeFile(
    join(repo, ".rivetari", "skills.lock"),
    [
      "version: 1",
      "skills:",
      entry("test-driven-development", "always", hash),
      ...extra.map((n) => entry(n, "task")),
      "",
    ].join("\n"),
  );
  await writeFile(
    join(repo, ".rivetari", "skills.state.json"),
    JSON.stringify({
      syncedAt: "2026-11-24T00:00:00Z",
      lock: await lockDigest(repo),
      skills: [],
      blocked: [],
    }),
  );
  git(repo, "add", "-A");
  return repo;
}

const skillsCheck = async (repo: string) =>
  (
    await doctorChecks(repo, {
      token: "t",
      claude: async () => "2.1.0",
      guardInShell: async () => true,
    })
  ).find((c) => c.name === "skills");

describe("doctor on a lock that routes nothing", () => {
  it("warns when the lock holds no task skill for the sectors the repo's files route to", async () => {
    const check = await skillsCheck(
      await webApp(
        [],
        "version: 1\nname: demo\ntype: web-app\nfloorplan: true\n",
      ),
    );
    expect(check?.status).toBe("warn");
    expect(check?.detail).toMatch(/^installed skills match the lock, but /);
    expect(check?.detail).toMatch(
      /no task skill for ui \([^)]*frontend-design[^)]*\), a11y \(accessibility-lead\), which files like src\/app\/\S+ route to/,
    );
    expect(check?.detail).toContain("the floorplan skill isn't locked");
    expect(check?.detail).toContain("`rivetari skills add <source>`");
  });

  it("is fine once the lock covers those sectors", async () => {
    const check = await skillsCheck(
      await webApp(["a11y-core", "accessibility-lead", "impeccable"]),
    );
    expect(check).toMatchObject({
      status: "ok",
      detail: "installed skills match the lock",
    });
  });
});
