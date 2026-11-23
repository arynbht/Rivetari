// `rivetari task run` writes each beat's live progress while it runs, and the
// build's carries the agent's turns, tokens and last tool.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { approveRoute, routeTask } from "../router/task-route.js";
import { progressPath, type TaskProgress } from "./progress.js";
import { runTask } from "./run.js";
import { confirmTask, newTask } from "./tasks.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-10T18:00:00Z") };

const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) {
    await simpleGit(d)
      .raw(["worktree", "prune"])
      .catch(() => undefined);
    await rm(d, { recursive: true, force: true });
  }
  made.length = 0;
});

async function approvedTask(): Promise<{ repo: string; id: string }> {
  const repo = await tmp("rivetari-run-progress-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "package.json"), '{ "name": "demo" }\n');
  await writeFile(join(repo, "src/total.js"), "exports.total = () => 0;\n");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  const { manifests } = await loadManifests(repo);
  const context = {
    manifests,
    available: new Set<string>(),
    flags: {},
    files: ["package.json", "src/total.js"],
    checks: ["quality.tests.pass"],
  };
  const draft = await newTask(
    repo,
    {
      title: "Fix total so it sums",
      type: "fix",
      description: "total() returns 0; it should sum its list.",
      acceptance: [{ id: "A1", text: "total sums a list", verify: "unit" }],
    },
    by,
  );
  const id = draft.card.id;
  await confirmTask(repo, id, by);
  await routeTask(repo, id, { ...by, context });
  await approveRoute(repo, id, { ...by, context });
  return { repo, id };
}

const read = async (repo: string, id: string) =>
  JSON.parse(await readFile(progressPath(repo, id), "utf8")) as TaskProgress;

describe("runTask's live progress", { timeout: 180_000 }, () => {
  it("writes the build's agent progress while it runs, and removes it after", async () => {
    const { repo, id } = await approvedTask();
    const during: TaskProgress[] = [];
    const outcome = await runTask(repo, id, {
      ...by,
      base: "main",
      agent: async (call) => {
        if (call.mode === "plan")
          return JSON.stringify({ steps: ["fix total"] });
        during.push(await read(repo, id));
        call.onProgress?.({ turns: 18, tokens: 52_000, lastTool: "Edit" });
        // Throttled: it lands within one throttle period.
        during.push(
          await vi.waitFor(
            async () => {
              const p = await read(repo, id);
              if (p.turns !== 18) throw new Error("not written yet");
              return p;
            },
            { timeout: 5000, interval: 50 },
          ),
        );
        return "changed nothing";
      },
    });
    expect(outcome.ran).toEqual(["isolate", "build"]);
    expect(during[0]).toMatchObject({ beat: "build", pid: process.pid });
    expect(during[1]).toMatchObject({
      beat: "build",
      turns: 18,
      tokens: 52_000,
      lastTool: "Edit",
    });
    await expect(readFile(progressPath(repo, id))).rejects.toThrow();
  });
});
