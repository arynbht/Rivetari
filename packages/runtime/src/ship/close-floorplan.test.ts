// Closing a merged task updates the floorplan only when the profile turns it
// on, and a floorplan that fails never stops the close.
import {
  access,
  cp,
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
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AgentRunner } from "../agent/build.js";
import { isSeal } from "../task/ledger.js";
import { loadTask, newTask } from "../task/tasks.js";
import {
  floorplanOnMerge,
  type FloorplanOptions,
} from "../map/floorplan-skill.js";
import { closeTask } from "./close.js";

const FIXTURE = fileURLToPath(
  new URL("../../test/fixtures/floorplan-skill", import.meta.url),
);

const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-23T10:00:00Z") };

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

/** A repo whose task shipped PR #7, with the profile given. */
async function shipped(profile: string): Promise<{ repo: string; id: string }> {
  const repo = await tmp("rivetari-close-floorplan-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await mkdir(join(repo, ".rivetari"));
  await writeFile(join(repo, ".rivetari", "profile.yml"), profile);
  await writeFile(join(repo, "index.js"), "console.log('hi');\n");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  const draft = await newTask(
    repo,
    {
      title: "Say hi",
      type: "feature",
      description: "Print a greeting.",
      acceptance: [{ id: "A1", text: "it says hi", verify: "unit" }],
    },
    by,
  );
  const task = await loadTask(repo, draft.card.id);
  await task.ledger.append({
    beat: "ship",
    section: "timeline",
    text: "draft PR opened: #7",
    by: "rivetari runtime",
    at: by.now,
  });
  return { repo, id: draft.card.id };
}

/** The hook `rivetari task close` passes, with a stand-in skill and transport. */
const onMerge = (repo: string, options: FloorplanOptions) => () =>
  floorplanOnMerge(repo, options);
const merged = async () => ({ state: "closed" as const, merged: true });
const PROFILE = "version: 1\nname: demo\ntype: cli\n";
const ARCH = { project: { name: "demo" }, nodes: [] };

async function skill(): Promise<string> {
  const dir = join(await tmp("rivetari-floorplan-skill-"), "floorplan");
  await cp(FIXTURE, dir, { recursive: true });
  return dir;
}

const answering: AgentRunner = async (call) => ({
  text: JSON.stringify(
    /JOB descriptions/.test(call.system)
      ? {
          files: { "src/index.js": { name: "Entry", description: "Says hi." } },
        }
      : ARCH,
  ),
  tokens: 500,
});

describe("close and the floorplan", { timeout: 60_000 }, () => {
  it("does nothing with the flag off", async () => {
    const { repo, id } = await shipped(PROFILE);
    const skillDir = await skill();
    let asked = 0;
    const { task, row } = await closeTask(repo, id, {
      ...by,
      prState: merged,
      floorplan: onMerge(repo, {
        skillDir,
        agent: async () => {
          asked++;
          return "{}";
        },
      }),
    });
    expect(row.outcome).toBe("merged");
    expect(asked).toBe(0);
    expect(task.entries.some((e) => e.text.startsWith("floorplan"))).toBe(
      false,
    );
    await expect(access(join(repo, "floorplan"))).rejects.toThrow();
    await expect(access(join(skillDir, "calls.log"))).rejects.toThrow();
    expect(isSeal(task.entries.at(-1)!)).toBe(true);
  });

  it("updates the map for a merged task when the flag is on", async () => {
    const { repo, id } = await shipped(`${PROFILE}floorplan: true\n`);
    const { task } = await closeTask(repo, id, {
      ...by,
      prState: merged,
      floorplan: onMerge(repo, { skillDir: await skill(), agent: answering }),
    });
    expect(task.entries.find((e) => e.text.startsWith("floorplan"))?.text).toBe(
      "floorplan made · 2 call(s) · 1000 tokens",
    );
    expect(
      JSON.parse(
        await readFile(join(repo, "floorplan", "architecture.json"), "utf8"),
      ),
    ).toEqual(ARCH);
    expect(isSeal(task.entries.at(-1)!)).toBe(true);
  });

  it("a failing floorplan is logged and the close goes on", async () => {
    const { repo, id } = await shipped(`${PROFILE}floorplan: true\n`);
    const { task, row } = await closeTask(repo, id, {
      ...by,
      prState: merged,
      floorplan: onMerge(repo, {
        skillDir: await skill(),
        agent: async () => {
          throw new Error("claude exited with code 1");
        },
      }),
    });
    expect(row.outcome).toBe("merged");
    expect(task.entries.map((e) => e.text)).toContain(
      "floorplan update failed (close goes on): claude exited with code 1",
    );
    expect(isSeal(task.entries.at(-1)!)).toBe(true);
  });

  it("a task closed without merging leaves the map alone", async () => {
    const { repo, id } = await shipped(`${PROFILE}floorplan: true\n`);
    let asked = 0;
    await closeTask(repo, id, {
      ...by,
      prState: async () => ({ state: "closed", merged: false }),
      floorplan: onMerge(repo, {
        skillDir: await skill(),
        agent: async () => {
          asked++;
          return "{}";
        },
      }),
    });
    expect(asked).toBe(0);
    await expect(access(join(repo, "floorplan"))).rejects.toThrow();
  });
});
