// R-23: review cost was uneven, $3.67 on a tests-only PR against a usual
// $0.05–0.46. The model and effort now follow the risk and the size of the
// change, big test files go as their first part plus their test names,
// lockfiles as counts, and every round says what it cost.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AiClient, CompleteParams } from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { FAST_REVIEW_MODEL } from "./fast-path.js";
import { changeSize, reviewPlan, SMALL_CHANGE_LINES } from "./review-plan.js";
import {
  JUDGE_DEFAULT_MODEL,
  packChange,
  renderReview,
  runTier2,
  TEST_FILE_CAP,
  trimTestDiff,
} from "./tier2.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repoWithChange(
  base: Record<string, string>,
  change: Record<string, string>,
): Promise<{ dir: string; base: string; head: string }> {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-r23-"));
  made.push(dir);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  const write = async (files: Record<string, string>) => {
    for (const [path, contents] of Object.entries(files)) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), contents, "utf8");
    }
    await git.add(["-A"]);
    await git.commit("c", ["--no-verify"]);
    return (await git.revparse(["HEAD"])).trim();
  };
  const b = await write(base);
  const h = await write(change);
  return { dir, base: b, head: h };
}

/** A big generated test file: many cases with golden rows. */
function bigTest(cases: number): string {
  return Array.from(
    { length: cases },
    (_, i) =>
      `it("golden case ${i}", () => {\n  expect(score([${Array.from({ length: 40 }, (_, j) => (i * j) % 97).join(", ")}])).toBe(${i});\n});\n`,
  ).join("");
}

describe("R-23: the review's model and effort follow the risk", () => {
  const size = (source: number, sensitive = false) => ({
    source,
    tests: 500,
    sensitive,
  });

  it("sends a low-risk, small change to the smaller model at medium effort", () => {
    // T-0018: six new test files, no source.
    expect(reviewPlan({ risk: "low", size: size(0) })).toMatchObject({
      model: FAST_REVIEW_MODEL,
      effort: "medium",
    });
    expect(
      reviewPlan({ risk: "low", size: size(SMALL_CHANGE_LINES + 1) }).model,
    ).toBe(JUDGE_DEFAULT_MODEL);
  });

  it("gives high risk and the sensitive list the strong model at high effort", () => {
    expect(reviewPlan({ risk: "high", size: size(10) })).toMatchObject({
      model: JUDGE_DEFAULT_MODEL,
      effort: "high",
    });
    expect(reviewPlan({ risk: "low", size: size(10, true) })).toMatchObject({
      model: JUDGE_DEFAULT_MODEL,
      effort: "high",
      why: "it touches the repo's sensitive list",
    });
    expect(reviewPlan({ risk: "medium", size: size(10) })).toMatchObject({
      model: JUDGE_DEFAULT_MODEL,
      effort: "medium",
    });
  });

  it("uses the profile's models, and a model named for the run as given", () => {
    expect(
      reviewPlan({ risk: "low", size: size(5), small: "claude-haiku-5-5" })
        .model,
    ).toBe("claude-haiku-5-5");
    expect(
      reviewPlan({ risk: "medium", size: size(5), strong: "claude-fable-5-1" })
        .model,
    ).toBe("claude-fable-5-1");
    expect(
      reviewPlan({ risk: "low", size: size(5), forced: "x-model" }).model,
    ).toBe("x-model");
  });

  it(
    "counts source lines apart from tests, docs and lockfiles",
    { timeout: 30_000 },
    async () => {
      const r = await repoWithChange(
        { "src/a.ts": "export const a = 1;\n" },
        {
          "src/a.ts": "export const a = 2;\nexport const b = 3;\n",
          "src/a.test.ts": bigTest(3),
          "README.md": "# hi\n",
          "pnpm-lock.yaml": "lockfileVersion: 9\n",
          "src/score/method-c.ts": "export const c = 1;\n",
        },
      );
      const got = await changeSize(r.dir, r.base, r.head, ["src/score/**"]);
      expect(got).toEqual({ source: 4, tests: 9, sensitive: true });
    },
  );
});

describe(
  "R-23: what the review is sent is trimmed",
  { timeout: 30_000 },
  () => {
    it("sends a big test file as its first part and its test names", async () => {
      const r = await repoWithChange(
        { "src/score.ts": "export const score = (x: number[]) => x.length;\n" },
        {
          "src/score.test.ts": bigTest(200),
          "pnpm-lock.yaml": "lockfileVersion: 9\npackages: {}\n",
        },
      );
      const packed = await packChange(r.dir, r.base, r.head);
      expect(packed.files).toContain("src/score.test.ts");
      expect(packed.diff.length).toBeLessThan(TEST_FILE_CAP + 2_000);
      expect(packed.trimmed?.[0]?.note).toMatch(
        /^first \d+ of \d+ characters; \d+ more line\(s\) not shown; tests in them: "golden case \d+", .* and \d+ more$/,
      );
      expect(packed.omitted).toEqual([
        { path: "pnpm-lock.yaml", why: "generated", stats: "+2 −0 lines" },
      ]);
    });

    it("cuts at a line and names what it left out", () => {
      const diff = `@@ -0,0 +1,3 @@\n+it("a", () => {});\n+it("b", () => {});\n+test("c", () => {});\n`;
      const cut = trimTestDiff(diff, 30);
      expect(cut.diff.startsWith('@@ -0,0 +1,3 @@\n+it("a"')).toBe(false);
      expect(cut.note).toMatch(/tests in them: .*"c"/);
    });

    it("passes the effort on, and says each round's tokens and cost", async () => {
      const r = await repoWithChange(
        { "src/a.ts": "export const a = 1;\n" },
        { "src/a.ts": "export const a = 2;\n" },
      );
      const calls: CompleteParams[] = [];
      const ai: AiClient = {
        async complete(params) {
          calls.push(params);
          return {
            text: '{"findings":[],"acceptance":[]}',
            usage: { inputTokens: 1000, outputTokens: 200 },
            model: params.model ?? "m",
            costUsd: 0.0123,
          };
        },
      };
      const lines: string[] = [];
      const result = await runTier2({
        repoPath: r.dir,
        base: r.base,
        head: r.head,
        ai,
        model: FAST_REVIEW_MODEL,
        effort: "medium",
        log: (l) => lines.push(l),
      });
      expect(calls[0]?.effort).toBe("medium");
      expect(lines).toContain("review: 1 call(s) · 1200 tokens · $0.01");
      expect(renderReview(result, 1, "approve")).toContain(
        `_${FAST_REVIEW_MODEL} (medium effort) · 1 call(s) · 1200 tokens · $0.01 ·`,
      );
    });
  },
);
