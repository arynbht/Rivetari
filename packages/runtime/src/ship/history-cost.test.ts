import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { confirmTask, loadTask, newTask } from "../task/tasks.js";
import { closeTask, promptTokens } from "./close.js";

const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-10T18:00:00Z") };

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repo(): Promise<string> {
  const dir = await tmp("rivetari-history-cost-");
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await writeFile(join(dir, "README.md"), "demo\n");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  return dir;
}

async function confirmed(dir: string): Promise<string> {
  const draft = await newTask(
    dir,
    {
      title: "Fix total so it sums",
      type: "fix",
      description: "total() returns 0; it should sum its list.",
      acceptance: [{ id: "A1", text: "total sums a list", verify: "unit" }],
      risk: "low",
    },
    by,
  );
  await confirmTask(dir, draft.card.id, by);
  return draft.card.id;
}

async function history(dir: string): Promise<Record<string, unknown>> {
  const text = await readFile(join(dir, ".rivetari", "history.jsonl"), "utf8");
  return JSON.parse(text.trim()) as Record<string, unknown>;
}

describe("close records risk and prompt size", { timeout: 60_000 }, () => {
  it("writes the card's risk and the largest prompt figure on the build-started lines", async () => {
    const dir = await repo();
    const id = await confirmed(dir);
    const task = await loadTask(dir, id);
    for (const text of [
      "build started · skills spine only · budget 12 steps / 60k ctx · 3 repo file(s) in context · ~18,400 prompt tokens · 1200 tokens",
      "build started · retry · ~9,200 prompt tokens · 2 repo file(s) in context",
    ])
      await task.ledger.append({
        beat: "build",
        section: "timeline",
        text,
        by: "rivetari runtime",
      });
    const { row } = await closeTask(dir, id, { ...by, abandon: "superseded" });
    expect(row.risk).toBe("low");
    expect(row.prompt_tokens).toBe(18_400);
    expect(await history(dir)).toMatchObject({
      task: id,
      risk: "low",
      prompt_tokens: 18_400,
    });
  });

  it("leaves prompt_tokens out when no build-started line carries a figure", async () => {
    const dir = await repo();
    const id = await confirmed(dir);
    const task = await loadTask(dir, id);
    await task.ledger.append({
      beat: "build",
      section: "timeline",
      text: "build started · skills spine only · budget 12 steps / 60k ctx · 3 repo file(s) in context · 1200 tokens",
      by: "rivetari runtime",
    });
    const { row } = await closeTask(dir, id, { ...by, abandon: "superseded" });
    expect(row.risk).toBe("low");
    expect("prompt_tokens" in row).toBe(false);
    const written = await history(dir);
    expect(written.risk).toBe("low");
    expect("prompt_tokens" in written).toBe(false);
  });
});

describe("promptTokens", () => {
  const entry = (beat: string, section: string, text: string) =>
    ({ beat, section, text }) as never;
  it("reads only the build-started timeline lines", () => {
    const task = {
      entries: [
        entry(
          "build",
          "timeline",
          "build started · 3 repo file(s) in context · ~4,000 prompt tokens",
        ),
        entry(
          "build",
          "timeline",
          "build done · commit abcdef123456 · 1 file(s) this round · ~90000 prompt tokens",
        ),
        entry("build", "plan", "build started · ~80000 prompt tokens"),
        entry("judge", "timeline", "build started · ~70000 prompt tokens"),
        entry("build", "timeline", "build started · ~5000 prompt tokens"),
      ],
    } as never;
    expect(promptTokens(task)).toBe(5000);
  });

  it("is undefined when no line carries a figure", () => {
    const task = {
      entries: [
        entry("build", "timeline", "build started · 3 repo file(s) in context"),
      ],
    } as never;
    expect(promptTokens(task)).toBeUndefined();
  });
});
