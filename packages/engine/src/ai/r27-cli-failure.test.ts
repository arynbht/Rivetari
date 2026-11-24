// R-27: the judge's review crashed with "claude CLI failed: claude exited with
// code 1" and nothing else. `claude -p --output-format json` reports its own
// failures as JSON on stdout with stderr empty, so the error now carries what
// it said, and a failure that looks passing is tried once more.
import { describe, expect, it } from "vitest";

import { CallExitError, spawnWithLimit } from "./call-limit.js";
import { claudeCliTransport, isTransientFailure } from "./claude-cli.js";
import { createAiClient } from "./client.js";
import { AiError } from "./types.js";

describe("R-27: a failed claude call says why", () => {
  it("keeps the JSON error claude printed on stdout when stderr is empty", async () => {
    const call = spawnWithLimit(
      process.execPath,
      [
        "-e",
        'process.stdout.write(JSON.stringify({type:"result",subtype:"error_during_execution",is_error:true,result:"API Error: 529 overloaded"})); process.exit(1)',
      ],
      { input: "" },
    );
    await expect(call).rejects.toThrow(
      "claude exited with code 1: error_during_execution: API Error: 529 overloaded",
    );
    const err = await call.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallExitError);
    expect((err as CallExitError).code).toBe(1);
  });

  it("says when a call printed nothing at all", async () => {
    await expect(
      spawnWithLimit(process.execPath, ["-e", "process.exit(1)"], {
        input: "",
      }),
    ).rejects.toThrow("claude exited with code 1 and printed nothing");
  });

  it("retries a passing failure once and goes on, but not one that explains itself", async () => {
    expect(isTransientFailure(new CallExitError(1, "", ""))).toBe(true);
    expect(
      isTransientFailure(new CallExitError(1, "", '{"result":"Overloaded"}')),
    ).toBe(true);
    expect(isTransientFailure(new CallExitError(1, "not signed in", ""))).toBe(
      false,
    );

    let calls = 0;
    const flaky = claudeCliTransport({
      run: async () => {
        calls++;
        if (calls === 1) throw new CallExitError(1, "", "");
        return JSON.stringify({ result: "ok", usage: {}, model: "m" });
      },
    });
    const ai = createAiClient({
      transport: flaky,
      maxRetries: 1,
      backoffMs: 0,
    });
    expect((await ai.complete({ prompt: "p" })).text).toBe("ok");
    expect(calls).toBe(2);

    let refused = 0;
    const signedOut = claudeCliTransport({
      run: async () => {
        refused++;
        throw new CallExitError(1, "not signed in", "");
      },
    });
    const err = await createAiClient({
      transport: signedOut,
      maxRetries: 1,
      backoffMs: 0,
    })
      .complete({ prompt: "p" })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as Error).message).toContain("not signed in");
    expect(refused).toBe(1);
  });
});

describe("R-23: the review's effort reaches the CLI", () => {
  it("passes the effort to the CLI as --effort", async () => {
    let seen: string[] = [];
    await claudeCliTransport({
      run: async (args) => {
        seen = args;
        return JSON.stringify({ result: "ok", usage: {}, model: "m" });
      },
    }).create(
      {
        model: "m",
        system: undefined,
        prompt: "p",
        maxTokens: 10,
        effort: "medium",
      },
      undefined,
    );
    expect(seen[seen.indexOf("--effort") + 1]).toBe("medium");
  });
});
