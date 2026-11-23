import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadTask, newTask } from "../task/tasks.js";
import { closeTask, promptTokens } from "./close.js";

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

async function closedRow(
  risk: "low" | "medium" | "high",
  buildLines: string[],
): Promise<Record<string, unknown>> {
  const dir = await repo();
  const draft = await newTask(
    dir,
    {
      title: "Sum the list",
      type: "fix",
      description: "total() returns 0; it should sum its list.",
      acceptance: [{ id: "A1", text: "total sums a list", verify: "unit" }],
      risk,
    },
    by,
  );
  const id = draft.card.id;
  const task = await loadTask(dir, id);
  for (const text of buildLines)
    await task.ledger.append({
      beat: "build",
      section: "timeline",
      text,
      by: "rivetari runtime",
      at: by.now,
    });
  await closeTask(dir, id, { ...by, abandon: "measuring" });
  const lines = (
    await readFile(join(dir, ".rivetari", "history.jsonl"), "utf8")
  )
    .trim()
    .split("\n");
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

describe("history row risk and prompt size", { timeout: 60_000 }, () => {
  it("records the card's risk and the largest prompt figure on build-started lines", async () => {
    const row = await closedRow("low", [
      "build started · skills spine only · budget 12 steps / 60k ctx · ~1200 prompt tokens · 3 repo file(s) in context · 900 tokens",
      "build done · commit abcdef123456 · 1 file(s) this round · 500 tokens",
      "build started · skills spine only · budget 12 steps / 60k ctx · ~4800 prompt tokens · 3 repo file(s) in context · 900 tokens",
    ]);
    expect(row).toMatchObject({ risk: "low", prompt_tokens: 4800 });
  });

  it("leaves prompt_tokens out when no build-started line carries a figure", async () => {
    const row = await closedRow("high", [
      "build started · skills spine only · budget 12 steps / 60k ctx · 3 repo file(s) in context · 900 tokens",
    ]);
    expect(row.risk).toBe("high");
    expect(row).not.toHaveProperty("prompt_tokens");
  });
});

describe("promptTokens", () => {
  const entry = (beat: string, section: string, text: string) =>
    ({ beat, section, text }) as never;

  it("reads only the runtime's build-started lines, never an agent's summary", () => {
    const task = {
      entries: [
        entry(
          "build",
          "timeline",
          "build started · fast path (low risk, 2 source file(s)): planned from the card's criteria, no plan call · budget 8 steps / 60k ctx · ~2,500 prompt tokens",
        ),
        entry(
          "build",
          "timeline",
          "build done · commit abcdef123456 · 1 file(s) this round · 500 tokens · said ~999999 prompt tokens",
        ),
        entry("build", "plan", "1. build started with ~888888 prompt tokens"),
        entry("judge", "judge", "build started · ~777777 prompt tokens"),
      ],
    } as never;
    expect(promptTokens(task)).toBe(2500);
  });

  it("reads a k figure, and gives undefined when no line has one", () => {
    const withK = {
      entries: [
        entry("build", "timeline", "build started · ~12k prompt tokens"),
        entry("build", "timeline", "build started · ~900 prompt tokens"),
      ],
    } as never;
    expect(promptTokens(withK)).toBe(12000);
    expect(
      promptTokens({
        entries: [entry("build", "timeline", "build started · 3 repo file(s)")],
      } as never),
    ).toBeUndefined();
  });
});
