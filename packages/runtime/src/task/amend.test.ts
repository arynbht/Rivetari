import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isolateTask } from "../agent/isolate.js";
import {
  approveRoute,
  type RouteContext,
  routeTask,
} from "../router/task-route.js";
import { confirmTask, loadTask, newTask, nextStep, sha256 } from "./tasks.js";

const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
let repo: string;
let context: RouteContext;
const by = { by: "dev@example.com", now: new Date("2026-11-23T10:00:00Z") };
const amender = {
  by: "lead@example.com",
  now: new Date("2026-11-23T11:00:00Z"),
};

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
  repo = await tmp("rivetari-amend-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await writeFile(join(repo, "README.md"), "# demo\n");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  const { manifests } = await loadManifests(repo);
  context = {
    manifests,
    available: new Set(),
    flags: {},
    files: ["src/total.ts", "docs/total.md"],
    checks: ["quality.tests.pass"],
  };
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

async function confirmedTask(): Promise<string> {
  const draft = await newTask(
    repo,
    {
      title: "Fix the total query",
      type: "fix",
      description: "total should sum the order lines.",
      acceptance: [{ id: "A1", text: "total sums lines", verify: "unit" }],
      touches: ["src/total.ts"],
    },
    by,
  );
  await confirmTask(repo, draft.card.id, by);
  return draft.card.id;
}

const cardFile = (id: string) => join(repo, ".rivetari/tasks", id, "card.yml");

async function editCard(id: string): Promise<{ old: string; next: string }> {
  const path = cardFile(id);
  const before = await readFile(path, "utf8");
  const after = before.replace(
    "  - src/total.ts\n",
    "  - src/total.ts\n  - docs/total.md\n",
  );
  expect(after).not.toBe(before);
  await writeFile(path, after, "utf8");
  return { old: sha256(before), next: sha256(after) };
}

describe("amending a confirmed card before isolate", () => {
  it("records the amendment, who made it and both hashes, and verifies", async () => {
    const id = await confirmedTask();
    const { old, next } = await editCard(id);
    expect((await loadTask(repo, id)).problems).toContain(
      "card.yml changed after intake was confirmed",
    );

    const task = await confirmTask(repo, id, amender);
    const last = task.entries[task.entries.length - 1]!;
    expect(last.text).toBe(`intake amended; card sha256 ${next} (was ${old})`);
    expect(last.by).toBe("lead@example.com");
    expect(last.beat).toBe("intake");
    expect(task.confirmed).toBe(true);
    expect(task.card.touches).toEqual(["src/total.ts", "docs/total.md"]);

    const reloaded = await loadTask(repo, id);
    expect(reloaded.problems).toEqual([]);
    await expect(confirmTask(repo, id, amender)).rejects.toThrow(
      /already confirmed/,
    );
  });

  it("drops the earlier route approval: route is next, and the new assembly can be approved", async () => {
    const id = await confirmedTask();
    await routeTask(repo, id, { ...by, context });
    const first = await approveRoute(repo, id, { ...by, context });
    expect(first.task.approved).toBe(true);
    expect(nextStep(first.task)).toMatch(/^isolate: /);

    await editCard(id);
    const amended = await confirmTask(repo, id, amender);
    expect(amended.approved).toBe(false);
    expect(amended.problems).toEqual([]);
    expect(nextStep(amended)).toMatch(/^route: `rivetari task route T-0001`/);

    const rerouted = await routeTask(repo, id, { ...by, context });
    expect(rerouted.task.problems).toEqual([]);
    expect(nextStep(rerouted.task)).toMatch(/^route: review assembly.yml/);

    const approved = await approveRoute(repo, id, { ...by, context });
    expect(approved.task.approved).toBe(true);
    expect(approved.task.problems).toEqual([]);
    expect(nextStep(approved.task)).toMatch(/^isolate: /);
  });
});

describe("after isolate the card is fixed", () => {
  it("refuses to confirm an edited card and still reports the edit", async () => {
    const id = await confirmedTask();
    await routeTask(repo, id, { ...by, context });
    await approveRoute(repo, id, { ...by, context });
    await isolateTask(repo, id, { ...by, base: "main" });
    const entries = (await loadTask(repo, id)).entries.length;

    await editCard(id);
    await expect(confirmTask(repo, id, amender)).rejects.toThrow(
      /card is fixed after isolate/,
    );
    const task = await loadTask(repo, id);
    expect(task.problems).toContain(
      "card.yml changed after intake was confirmed",
    );
    expect(task.entries).toHaveLength(entries);
    expect(task.entries.some((e) => e.text.startsWith("intake amended"))).toBe(
      false,
    );
  });
});
