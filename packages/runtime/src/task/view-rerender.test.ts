import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadTask, newTask } from "./tasks.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-23T05:00:00Z") };

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
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function draftedTask() {
  const repo = await tmp("rivetari-view-");
  await simpleGit(repo).init(["-b", "main"]);
  const draft = await newTask(
    repo,
    {
      title: "Fix total",
      type: "fix",
      description: "d",
      acceptance: [{ id: "A1", text: "sums", verify: "unit" }],
    },
    by,
  );
  return { repo, id: draft.card.id, md: draft.ledger.mdPath };
}

describe("a task ledger's rendered view", () => {
  it("is rendered again when only the view differs, and the task verifies", async () => {
    const { repo, id, md } = await draftedTask();
    const fresh = await readFile(md, "utf8");
    await writeFile(
      md,
      fresh.replace("# T-0001", "# T-0001 (renamed product)"),
    );

    const task = await loadTask(repo, id);
    expect(task.problems).toEqual([]);
    expect(task.viewRerendered).toBe(true);
    expect(await readFile(md, "utf8")).toBe(fresh);
  });

  it("isn't touched when it already matches", async () => {
    const { repo, id } = await draftedTask();
    const task = await loadTask(repo, id);
    expect(task.problems).toEqual([]);
    expect(task.viewRerendered).toBe(false);
  });

  it("still fails a ledger whose signed entry was changed", async () => {
    const { repo, id } = await draftedTask();
    const jsonl = join(repo, ".rivetari", "tasks", id, "ledger.jsonl");
    const text = await readFile(jsonl, "utf8");
    await writeFile(
      jsonl,
      text.replace("card drafted", "card drafted by hand"),
    );

    const task = await loadTask(repo, id);
    expect(task.viewRerendered).toBe(false);
    expect(task.problems).toContainEqual(
      expect.stringMatching(/contents don't match its seal/),
    );
  });
});
