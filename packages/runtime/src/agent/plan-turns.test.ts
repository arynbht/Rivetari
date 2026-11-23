// claudeAgent against a stand-in `claude` that answers like the real CLI does
// when a call reaches --max-turns: exit 1 and an error_max_turns result.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeAgent } from "./build.js";

// The shape claude 2.1 printed for `-p --output-format json --max-turns 4`.
const MAX_TURNS = {
  type: "result",
  subtype: "error_max_turns",
  is_error: true,
  num_turns: 5,
  errors: ["Reached maximum number of turns (4)"],
  terminal_reason: "max_turns",
  total_cost_usd: 0.12,
  usage: {
    input_tokens: 10,
    output_tokens: 20,
    cache_creation_input_tokens: 30,
    cache_read_input_tokens: 40,
  },
};

let dir: string;
const savedPath = process.env.PATH;

async function fakeClaude(result: object, exitCode: number): Promise<void> {
  const script = join(dir, "fake-claude.cjs");
  await writeFile(
    script,
    `process.stdin.resume();
process.stdin.on("end", () => {
  require("fs").writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
  process.stdout.write(${JSON.stringify(JSON.stringify(result))});
  process.exit(${exitCode});
});
`,
  );
  if (process.platform === "win32")
    await writeFile(
      join(dir, "claude.cmd"),
      `@echo off\r\nnode "${script}" %*\r\n`,
    );
  else
    await writeFile(
      join(dir, "claude"),
      `#!/bin/sh\nexec node "${script}" "$@"\n`,
      {
        mode: 0o755,
      },
    );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rivetari-fake-claude-"));
  process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  await rm(dir, { recursive: true, force: true });
});

const call = () => ({
  mode: "plan" as const,
  system: "plan it",
  prompt: "the task",
  cwd: dir,
  env: { ...process.env },
  maxTurns: 4,
});

describe("claudeAgent at the turn limit", () => {
  it("returns the limit it stopped at, with what the call cost, instead of failing", async () => {
    await fakeClaude(MAX_TURNS, 1);
    const reply = await claudeAgent(call());
    expect(reply).toEqual({
      text: "",
      tokens: 100,
      costUsd: 0.12,
      turns: 5,
      turnLimit: 4,
    });
    const argv = JSON.parse(
      await readFile(join(dir, "argv.json"), "utf8"),
    ) as string[];
    expect(argv.join(" ")).toContain("--max-turns 4");
  });

  it("still fails on any other error", async () => {
    await fakeClaude(
      { type: "result", subtype: "error_during_execution", is_error: true },
      1,
    );
    await expect(claudeAgent(call())).rejects.toThrow();
  });
});
