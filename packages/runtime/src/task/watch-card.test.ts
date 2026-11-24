import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { confirmTask, newTask, TASKS_DIR } from "./tasks.js";
import { readTasks } from "./watch.js";

// The shell's Needs-you queue shows the card a person confirms and the
// assembly they approve, so a task's view carries both as the record has them.

const BY = "ann@example.com";
const NOW = new Date("2026-11-20T10:00:00Z");
const CARD = {
  type: "feature" as const,
  description: "Readers can switch the theme.",
  acceptance: [
    { id: "A1", text: "A toggle switches the theme", verify: "e2e" as const },
    { id: "A2", text: "The choice is kept", verify: "unit" as const },
  ],
};
const ASSEMBLY = "task: T-0002\nsectors: [ui]\n";

let repo = "";
let config = "";
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();

beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), "rivetari-config-"));
  process.env.RIVETARI_CONFIG_DIR = config;
  repo = await mkdtemp(join(tmpdir(), "rivetari-repo-"));
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  git("commit", "-q", "--allow-empty", "-m", "base", "--no-verify");
});

afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  await rm(repo, { recursive: true, force: true });
  await rm(config, { recursive: true, force: true });
});

describe("a task's view carries its card and assembly", () => {
  it("has the drafted card before confirmation, and the assembly once routed", async () => {
    await newTask(
      repo,
      { ...CARD, title: "Dark mode" },
      { by: BY, now: NOW, id: "T-0001" },
    );
    await newTask(
      repo,
      { ...CARD, title: "Routed" },
      { by: BY, now: NOW, id: "T-0002" },
    );
    await confirmTask(repo, "T-0002", { by: BY, now: NOW });
    await writeFile(join(repo, TASKS_DIR, "T-0002", "assembly.yml"), ASSEMBLY);

    const [drafted, routed] = await readTasks(repo);
    expect(drafted?.needsYou?.kind).toBe("intake");
    expect(drafted?.card).toMatchObject({
      id: "T-0001",
      title: "Dark mode",
      description: "Readers can switch the theme.",
      acceptance: CARD.acceptance,
    });
    expect(drafted?.assemblyText).toBeUndefined();

    expect(routed?.needsYou?.kind).toBe("route");
    expect(routed?.assemblyText).toBe(ASSEMBLY);
  });
});
