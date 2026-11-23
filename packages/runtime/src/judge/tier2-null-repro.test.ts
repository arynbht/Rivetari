// A finding whose repro the model sent as null is a finding with no repro, not
// a review that can't be read: the review still runs and is posted.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AiClient } from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { renderReview, runTier2 } from "./tier2.js";

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
  const dir = await mkdtemp(join(tmpdir(), "rivetari-tier2-null-"));
  made.push(dir);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  const write = async (contents: string) => {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/pay.js"), contents, "utf8");
    await git.add(["-A"]);
    await git.commit("c", ["--no-verify"]);
    return (await git.revparse(["HEAD"])).trim();
  };
  const base = await write("export const charge = (a) => a;\n");
  const head = await write("export const charge = (a) => a / 0;\n");
  return { dir, base, head };
}

function scripted(review: unknown, gate: unknown): AiClient {
  return {
    async complete(params) {
      const isGate = params.system?.startsWith(
        "You are checking one code-review finding",
      );
      return {
        text: JSON.stringify(isGate ? gate : review),
        usage: { inputTokens: 10, outputTokens: 5 },
        model: params.model ?? "m",
      };
    },
  };
}

const review = async (ai: AiClient) => {
  const r = await repoWithChange();
  return runTier2({ repoPath: r.dir, base: r.base, head: r.head, ai });
};

describe("a null repro", { timeout: 30_000 }, () => {
  it("on a suggestion is no repro, and the review is still rendered", async () => {
    const result = await review(
      scripted(
        {
          findings: [
            {
              kind: "suggestion",
              file: "src/pay.js",
              line: 1,
              title: "Name the zero",
              detail: null,
              repro: null,
              fix: null,
            },
          ],
          acceptance: [{ id: "A1", status: "met", note: null }],
        },
        {},
      ),
    );
    expect(result.verdict).toBe("approve");
    expect(result.suggestions).toMatchObject([
      { title: "Name the zero", repro: "", detail: "", fix: "" },
    ]);
    expect(renderReview(result, 1, "approve")).toContain("Name the zero");
  });

  it("on a blocking finding takes the gate's repro when it confirms one", async () => {
    const result = await review(
      scripted(
        {
          findings: [
            {
              kind: "defect",
              file: "src/pay.js",
              line: 1,
              title: "Division by zero",
              detail: "always Infinity",
              repro: null,
            },
          ],
        },
        {
          reproducible: true,
          repro: "charge(5) returns Infinity instead of 5",
          reason: null,
        },
      ),
    );
    expect(result.verdict).toBe("request-changes");
    expect(result.blocking.map((f) => f.repro)).toEqual([
      "charge(5) returns Infinity instead of 5",
    ]);
  });

  it("from the gate leaves a blocking finding unconfirmed, a suggestion", async () => {
    const result = await review(
      scripted(
        {
          findings: [
            {
              kind: "defect",
              file: "src/pay.js",
              line: 1,
              title: "Division by zero",
              repro: null,
            },
          ],
        },
        { reproducible: true, repro: null, reason: null },
      ),
    );
    expect(result.verdict).toBe("approve");
    expect(result.suggestions).toMatchObject([
      {
        title: "Division by zero",
        repro: "",
        downgraded: "no reproduction confirmed",
      },
    ]);
  });

  it("is left out of a rendered blocking finding rather than printed empty", async () => {
    const result = await review(
      scripted(
        {
          findings: [
            {
              kind: "defect",
              file: "src/pay.js",
              line: 1,
              title: "Division by zero",
              repro: null,
            },
          ],
        },
        {
          reproducible: true,
          repro: "charge(5) returns Infinity instead of 5",
        },
      ),
    );
    expect(result.blocking).toHaveLength(1);
    const blocking = {
      ...result,
      blocking: result.blocking.map((f) => ({ ...f, repro: "" })),
    };
    const body = renderReview(blocking, 1, "request-changes");
    expect(body).toContain("Division by zero");
    expect(body).not.toContain("**Repro:**");
  });
});
