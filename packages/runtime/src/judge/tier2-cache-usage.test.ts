import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AiClient, AiUsage } from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { runTier2 } from "./tier2.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repoWithChange(): Promise<{
  dir: string;
  base: string;
  head: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-tier2-cache-"));
  made.push(dir);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  const write = async (contents: string) => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.js"), contents, "utf8");
    await git.add(["-A"]);
    await git.commit("c", ["--no-verify"]);
    return (await git.revparse(["HEAD"])).trim();
  };
  const base = await write("export const a = 1;\n");
  const head = await write("export const a = 2;\n");
  return { dir, base, head };
}

function reviewer(usage: AiUsage, costUsd?: number): AiClient {
  return {
    async complete(params) {
      return {
        text: JSON.stringify({ findings: [], acceptance: [] }),
        usage,
        model: params.model ?? "m",
        ...(costUsd !== undefined ? { costUsd } : {}),
      };
    },
  };
}

describe("judge tier 2 token total", { timeout: 30_000 }, () => {
  it("includes cache creation and cache read tokens", async () => {
    const r = await repoWithChange();
    const result = await runTier2({
      repoPath: r.dir,
      base: r.base,
      head: r.head,
      ai: reviewer({
        inputTokens: 10,
        outputTokens: 5,
        cacheCreationTokens: 1_000,
        cacheReadTokens: 20_000,
      }),
      model: "claude-sonnet-4-6",
    });
    expect(result.calls).toBe(1);
    expect(result.usage.tokens).toBe(21_015);
    expect(result.usage.costUsd).toBeCloseTo(
      (10 * 3 + 5 * 15 + 1_000 * 3 * 1.25 + 20_000 * 3 * 0.1) / 1e6,
      10,
    );
  });

  it("keeps the reported cost over the estimate", async () => {
    const r = await repoWithChange();
    const result = await runTier2({
      repoPath: r.dir,
      base: r.base,
      head: r.head,
      ai: reviewer(
        {
          inputTokens: 10,
          outputTokens: 5,
          cacheCreationTokens: 1_000,
          cacheReadTokens: 20_000,
        },
        0.25,
      ),
      model: "claude-sonnet-4-6",
    });
    expect(result.usage.tokens).toBe(21_015);
    expect(result.usage.costUsd).toBe(0.25);
  });

  it("totals a result without cache fields as before", async () => {
    const r = await repoWithChange();
    const result = await runTier2({
      repoPath: r.dir,
      base: r.base,
      head: r.head,
      ai: reviewer({ inputTokens: 10, outputTokens: 5 }),
      model: "claude-sonnet-4-6",
    });
    expect(result.usage.tokens).toBe(15);
  });
});
