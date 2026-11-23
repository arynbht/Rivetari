// The stream-json reader, on lines recorded from claude 2.1 (`-p --output-format
// stream-json --verbose`, trimmed to the fields that matter), and claudeAgent
// against a stand-in `claude` that streams them.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { claudeAgent } from "./build.js";
import { type AgentProgress, resultLine, StreamProgress } from "./stream.js";

const usage = (input: number, output: number, write: number, read: number) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
});

const RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 4,
  result: "Done: the toggle is in.",
  total_cost_usd: 0.0421,
  usage: usage(6, 180, 6443, 62785),
};

/** A build call: read a file, edit it, a subagent's reply in between, then the answer. */
const LINES = [
  { type: "system", subtype: "init", cwd: "/repo", tools: ["Read", "Edit"] },
  {
    type: "assistant",
    message: {
      id: "msg_1",
      content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }],
      usage: usage(2, 40, 6272, 16747),
    },
    parent_tool_use_id: null,
  },
  { type: "rate_limit_event", rate_limit_info: { status: "allowed" } },
  {
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "t1" }] },
    parent_tool_use_id: null,
  },
  // One reply can arrive as more than one event: text first, then its tool call.
  {
    type: "assistant",
    message: {
      id: "msg_2",
      content: [{ type: "text", text: "Now the edit." }],
      usage: usage(2, 10, 0, 23019),
    },
    parent_tool_use_id: null,
  },
  {
    type: "assistant",
    message: {
      id: "msg_2",
      content: [{ type: "tool_use", id: "t2", name: "Edit", input: {} }],
      usage: usage(2, 120, 0, 23019),
    },
    parent_tool_use_id: null,
  },
  // A subagent's reply: its tool is the latest activity, but not a caller's turn.
  {
    type: "assistant",
    message: {
      id: "msg_sub",
      content: [{ type: "tool_use", id: "t3", name: "Grep", input: {} }],
      usage: usage(1, 1, 1, 1),
    },
    parent_tool_use_id: "t2",
  },
  {
    type: "assistant",
    message: {
      id: "msg_3",
      content: [{ type: "text", text: "Done: the toggle is in." }],
      usage: usage(2, 10, 171, 23019),
    },
    parent_tool_use_id: null,
  },
  RESULT,
].map((l) => JSON.stringify(l));

describe("reading a stream-json call", () => {
  it("counts the caller's replies, their tokens and the last tool, as each line lands", () => {
    const stream = new StreamProgress();
    const seen: AgentProgress[] = [];
    for (const line of LINES)
      if (stream.feed(line)) seen.push(stream.progress());

    expect(seen[0]).toEqual({ turns: 1, tokens: 23061, lastTool: "Read" });
    // msg_2's second event raises its tokens and names its tool; still one turn.
    expect(seen.map((p) => p.turns)).toEqual([1, 2, 2, 2, 3]);
    expect(seen[2]).toEqual({
      turns: 2,
      tokens: 23061 + 23141,
      lastTool: "Edit",
    });
    expect(seen[3]?.lastTool).toBe("Grep");
    expect(stream.progress()).toEqual({
      turns: 3,
      tokens: 23061 + 23141 + 23202,
      lastTool: "Grep",
    });
  });

  it("ignores what isn't an event: blank lines, half a line, plain text", () => {
    const stream = new StreamProgress();
    expect(stream.feed("")).toBe(false);
    expect(stream.feed('{"type":"assistant","mess')).toBe(false);
    expect(stream.feed("Warning: something on stdout")).toBe(false);
    expect(stream.progress()).toEqual({ turns: 0, tokens: 0 });
  });

  it("finds the result the json format would have printed", () => {
    expect(JSON.parse(resultLine(LINES.join("\n")) ?? "")).toEqual(RESULT);
    // A CLI (or stand-in) that prints the result alone, with no newline.
    expect(resultLine(JSON.stringify(RESULT))).toBe(JSON.stringify(RESULT));
    expect(resultLine(LINES.slice(0, -1).join("\n"))).toBeUndefined();
  });
});

let dir: string;
const savedPath = process.env.PATH;

/** A stand-in `claude` that streams `lines`, a little apart, then exits. */
async function fakeClaude(lines: string[], exitCode = 0): Promise<void> {
  const script = join(dir, "fake-claude.cjs");
  await writeFile(
    script,
    `process.stdin.resume();
process.stdin.on("end", async () => {
  require("fs").writeFileSync(${JSON.stringify(join(dir, "argv.json"))}, JSON.stringify(process.argv.slice(2)));
  for (const line of ${JSON.stringify(lines)}) {
    process.stdout.write(line + "\\n");
    await new Promise((r) => setTimeout(r, 20));
  }
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
      { mode: 0o755 },
    );
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rivetari-stream-claude-"));
  process.env.PATH = `${dir}${delimiter}${savedPath ?? ""}`;
});
afterEach(async () => {
  process.env.PATH = savedPath;
  await rm(dir, { recursive: true, force: true });
});

const call = (onProgress?: (p: AgentProgress) => void) => ({
  mode: "build" as const,
  system: "build it",
  prompt: "the task",
  cwd: dir,
  env: { ...process.env },
  onProgress,
});

describe("claudeAgent on the stream", () => {
  it("reports progress while the call runs, and the same reply the json format gave", async () => {
    await fakeClaude(LINES);
    const seen: AgentProgress[] = [];
    const reply = await claudeAgent(call((p) => seen.push(p)));
    expect(reply).toEqual({
      text: "Done: the toggle is in.",
      tokens: 6 + 180 + 6443 + 62785,
      costUsd: 0.0421,
      turns: 4,
      turnLimit: undefined,
    });
    expect(seen.at(-1)).toEqual({
      turns: 3,
      tokens: 23061 + 23141 + 23202,
      lastTool: "Grep",
    });
    const argv = JSON.parse(
      await readFile(join(dir, "argv.json"), "utf8"),
    ) as string[];
    expect(argv.join(" ")).toContain("--output-format stream-json --verbose");
  });

  it("still returns the turn limit a streamed call stopped at", async () => {
    await fakeClaude(
      [
        LINES[1] as string,
        JSON.stringify({
          type: "result",
          subtype: "error_max_turns",
          is_error: true,
          num_turns: 5,
          total_cost_usd: 0.12,
          usage: usage(10, 20, 30, 40),
        }),
      ],
      1,
    );
    const reply = await claudeAgent({ ...call(), mode: "plan", maxTurns: 4 });
    expect(reply).toEqual({
      text: "",
      tokens: 100,
      costUsd: 0.12,
      turns: 5,
      turnLimit: 4,
    });
  });

  it("fails a call that ends without a result", async () => {
    await fakeClaude(LINES.slice(0, -1), 1);
    await expect(claudeAgent(call())).rejects.toThrow();
  });
});
