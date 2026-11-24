import { describe, expect, it, vi } from "vitest";

import { CallExitError } from "./call-limit.js";
import { AiError } from "./client.js";
import { claudeCliTransport } from "./claude-cli.js";

const OK = JSON.stringify({ result: "ok", usage: {}, model: "m" });
const REFUSED = new CallExitError(1, "error: unknown option '--effort'", "");
const request = {
  model: "claude-opus-5-5",
  prompt: "review it",
  maxTokens: 100,
  effort: "medium" as const,
};

describe("claudeCliTransport on a claude without --effort", () => {
  it("runs the call again without --effort, and doesn't pass it after that", async () => {
    const run = vi
      .fn<(args: string[]) => Promise<string>>()
      .mockRejectedValueOnce(REFUSED)
      .mockResolvedValue(OK);
    const transport = claudeCliTransport({ run });

    const first = await transport.create(request, undefined);
    const second = await transport.create(request, undefined);

    expect(first.text).toBe("ok");
    expect(second.text).toBe("ok");
    const calls = run.mock.calls.map(([args]) => args);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain("--effort");
    expect(calls[1]).not.toContain("--effort");
    expect(calls[2]).not.toContain("--effort");
  });

  it("still fails a call that's refused for anything else", async () => {
    const run = vi
      .fn<(args: string[]) => Promise<string>>()
      .mockRejectedValue(new CallExitError(1, "error: not signed in", ""));
    const transport = claudeCliTransport({ run });

    await expect(transport.create(request, undefined)).rejects.toBeInstanceOf(
      AiError,
    );
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("passes --effort to a claude that knows it", async () => {
    const run = vi
      .fn<(args: string[]) => Promise<string>>()
      .mockResolvedValue(OK);
    await claudeCliTransport({ run }).create(request, undefined);
    const [args] = run.mock.calls[0]!;
    expect(
      args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2),
    ).toEqual(["--effort", "medium"]);
  });
});
