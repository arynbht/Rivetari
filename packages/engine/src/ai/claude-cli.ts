// A transport that runs the local Claude Code CLI in headless mode instead of the
// metered Messages API — so Rivetari's AI uses the developer's Claude
// subscription (`claude login`), not an API key. The subprocess runner is
// injectable so the JSON parsing is unit-tested without spawning anything.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveOnWindows } from "../detectors/exec.js";
import {
  CallExitError,
  CallTimeoutError,
  spawnWithLimit,
} from "./call-limit.js";
import {
  AiError,
  type AiTransport,
  type CompleteResult,
  type TransportRequest,
} from "./types.js";

/** Runs `claude` with args, feeding `input` on stdin; resolves stdout. */
export type ClaudeRunner = (
  args: string[],
  input: string,
  signal?: AbortSignal,
  cwd?: string,
) => Promise<string>;

export interface ClaudeCliOptions {
  model?: string | undefined;
  /** Inject a fake runner in tests; omit to spawn the real `claude` binary. */
  run?: ClaudeRunner | undefined;
}

/** Resolve the `claude` invocation, handling a Windows `.cmd`/`.bat` shim. */
export async function claudeCommand(
  args: string[],
): Promise<{ command: string; argv: string[] }> {
  if (process.platform !== "win32") return { command: "claude", argv: args };
  const resolved = await resolveOnWindows("claude");
  if (!resolved) throw new Error("the `claude` CLI was not found on PATH");
  if (/\.(cmd|bat)$/i.test(resolved)) {
    return { command: "cmd.exe", argv: ["/d", "/s", "/c", resolved, ...args] };
  }
  return { command: resolved, argv: args };
}

const defaultRunner: ClaudeRunner = async (args, input, signal, cwd) => {
  const { command, argv } = await claudeCommand(args);
  return spawnWithLimit(command, argv, { input, cwd, signal });
};

/** Parse Claude Code's `--output-format json` result into a CompleteResult. */
export function parseClaudeJson(
  stdout: string,
  fallbackModel: string,
): CompleteResult {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new AiError("the claude CLI returned non-JSON output", false);
  }
  if (data.is_error === true) {
    const said =
      typeof data.result === "string"
        ? data.result
        : "the claude CLI reported an error";
    throw new AiError(said, TRANSIENT.test(said));
  }
  const usage = (data.usage ?? {}) as Record<string, unknown>;
  return {
    text: typeof data.result === "string" ? data.result : "",
    usage: {
      inputTokens: Number(usage.input_tokens ?? 0),
      outputTokens: Number(usage.output_tokens ?? 0),
      ...(usage.cache_creation_input_tokens !== undefined
        ? {
            cacheCreationTokens: Number(usage.cache_creation_input_tokens),
          }
        : {}),
      ...(usage.cache_read_input_tokens !== undefined
        ? { cacheReadTokens: Number(usage.cache_read_input_tokens) }
        : {}),
    },
    model: typeof data.model === "string" ? data.model : fallbackModel,
    costUsd:
      typeof data.total_cost_usd === "number" ? data.total_cost_usd : undefined,
  };
}

/**
 * Flags that make a `claude -p` call a pure completion: the model sees only the
 * prompt (the context packer's output) and can't reach anything else.
 *  - no tools, so it can't read `.env` or any file;
 *  - safe mode: no CLAUDE.md, skills, plugins, hooks or MCP from any repo or
 *    user config (Rivetari never honours a target repo's .claude settings);
 *  - no saved session.
 */
export const LOCKED_DOWN_ARGS = [
  "--tools",
  "",
  "--safe-mode",
  "--strict-mcp-config",
  "--no-session-persistence",
];

/** What a passing outage says: overload, rate limits, 5xx, a dropped connection. */
const TRANSIENT =
  /overload|rate.?limit|\b429\b|\b5\d\d\b|timed? ?out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network|temporar/i;

/**
 * Whether a failed call is worth one more try: it said something transient,
 * or exited non-zero and said nothing at all, which in the pilot was a one-off
 * that a re-run got past. A call that explains itself (not signed in, a bad
 * flag) fails the same way again, so it isn't retried.
 */
export function isTransientFailure(err: unknown): boolean {
  if (err instanceof CallExitError)
    return err.detail === "" || TRANSIENT.test(err.detail);
  return err instanceof Error && TRANSIENT.test(err.message);
}

/** An older `claude` that doesn't know `--effort` says so and exits. */
const NO_EFFORT = /unknown option '--effort'/i;

/** Build a transport backed by the local `claude` CLI (subscription auth). */
export function claudeCliTransport(
  options: ClaudeCliOptions = {},
): AiTransport {
  const run = options.run ?? defaultRunner;
  // Learned on the first refusal, so only one call pays for the retry.
  let effortSupported = true;
  return {
    async create(req: TransportRequest, signal) {
      const argsFor = (withEffort: boolean) => {
        const args = [
          "-p",
          "--output-format",
          "json",
          "--model",
          req.model,
          ...LOCKED_DOWN_ARGS,
        ];
        if (req.effort && withEffort) args.push("--effort", req.effort);
        if (req.system) args.push("--append-system-prompt", req.system);
        return args;
      };
      // An empty working directory: even a tool that slipped through finds
      // nothing to read.
      const cwd = await mkdtemp(join(tmpdir(), "rivetari-claude-"));
      let stdout: string;
      try {
        try {
          stdout = await run(argsFor(effortSupported), req.prompt, signal, cwd);
        } catch (err) {
          // Effort only tunes the call; without it the review still runs.
          if (!req.effort || !effortSupported || !NO_EFFORT.test(String(err)))
            throw err;
          effortSupported = false;
          stdout = await run(argsFor(false), req.prompt, signal, cwd);
        }
      } catch (err) {
        // A call past its limit stops the task; it isn't a failure to retry.
        if (err instanceof CallTimeoutError) throw err;
        throw new AiError(
          `claude CLI failed: ${(err as Error).message}`,
          isTransientFailure(err),
        );
      } finally {
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
      return parseClaudeJson(stdout, req.model);
    },
  };
}

/** True when the `claude` CLI is on PATH (so we can use the subscription). */
export async function claudeCliAvailable(): Promise<boolean> {
  try {
    if (process.platform === "win32") {
      return (await resolveOnWindows("claude")) !== null;
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn("claude", ["--version"], { windowsHide: true });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`exit ${code}`)),
      );
    });
    return true;
  } catch {
    return false;
  }
}
