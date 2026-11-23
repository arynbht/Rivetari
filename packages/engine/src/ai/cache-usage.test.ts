import { describe, expect, it } from "vitest";

import { parseClaudeJson } from "./claude-cli.js";
import { estimateCost } from "./usage.js";

describe("cache tokens in the CLI transport's usage", () => {
  it("parseClaudeJson returns cache creation and cache read tokens", () => {
    const out = JSON.stringify({
      type: "result",
      result: "ok",
      model: "claude-opus-5-5",
      usage: {
        input_tokens: 12,
        output_tokens: 3_690,
        cache_creation_input_tokens: 8_000,
        cache_read_input_tokens: 42_000,
      },
    });
    expect(parseClaudeJson(out, "m").usage).toEqual({
      inputTokens: 12,
      outputTokens: 3_690,
      cacheCreationTokens: 8_000,
      cacheReadTokens: 42_000,
    });
  });

  it("a result with no cache fields gives the same usage as before", () => {
    const out = JSON.stringify({
      result: "ok",
      usage: { input_tokens: 120, output_tokens: 45 },
    });
    const usage = parseClaudeJson(out, "m").usage;
    expect(usage).toEqual({ inputTokens: 120, outputTokens: 45 });
    expect("cacheCreationTokens" in usage).toBe(false);
    expect("cacheReadTokens" in usage).toBe(false);
  });

  it("estimateCost prices cache creation at 1.25x and cache reads at 0.1x the input rate", () => {
    const none = { inputTokens: 0, outputTokens: 0 };
    expect(
      estimateCost("claude-sonnet-4-6", {
        ...none,
        cacheCreationTokens: 1_000_000,
      }),
    ).toBeCloseTo(3.75, 5);
    expect(
      estimateCost("claude-sonnet-4-6", {
        ...none,
        cacheReadTokens: 1_000_000,
      }),
    ).toBeCloseTo(0.3, 5);
    expect(
      estimateCost("claude-opus-5-5", {
        inputTokens: 1_000_000,
        outputTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
        cacheReadTokens: 1_000_000,
      }),
    ).toBeCloseTo(4 + 20 + 5 + 0.4, 5);
  });

  it("estimateCost is unchanged for usage without cache tokens", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(estimateCost("claude-sonnet-4-6", usage)).toBeCloseTo(18, 5);
    expect(
      estimateCost("claude-sonnet-4-6", {
        ...usage,
        cacheCreationTokens: undefined,
        cacheReadTokens: undefined,
      }),
    ).toBeCloseTo(18, 5);
    expect(
      estimateCost("some-future-model", {
        ...usage,
        cacheReadTokens: 1_000_000,
      }),
    ).toBe(0);
  });
});
