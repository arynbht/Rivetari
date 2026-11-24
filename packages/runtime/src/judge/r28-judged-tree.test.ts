// R-28: a PR whose head became a merge commit had no judge record, though
// its tree was byte for byte a judged head's: a person compared trees by
// hand. The review marker carries the tree, and a head with an identical
// tree carries the earlier verdict, saying so.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { carriedFor, readMarker, renderCarried, treeOf } from "./review.js";
import { renderReview, type Tier2Result } from "./tier2.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

/** A judged head, and a merge commit after it whose tree is the same. */
async function mergedHead(): Promise<{
  dir: string;
  judged: string;
  merge: string;
  tree: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-r28-"));
  made.push(dir);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src/a.js"), "export const a = 1;\n");
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  await writeFile(join(dir, "src/a.js"), "export const a = 2;\n");
  await git.add(["-A"]);
  await git.commit("fix", ["--no-verify"]);
  const judged = (await git.revparse(["HEAD"])).trim();
  const tree = await treeOf(dir, judged);
  // The fix-on-branch flow: a merge whose result is the judged tree.
  const merge = (
    await git.raw([
      "commit-tree",
      tree,
      "-p",
      judged,
      "-p",
      `${judged}~1`,
      "-m",
      "Merge fix into the branch",
    ])
  ).trim();
  return { dir, judged, merge, tree };
}

const approved = {
  verdict: "approve",
  blocking: [],
  suggestions: [],
  acceptance: [{ id: "A1", status: "met", note: "" }],
  unreviewed: [],
  model: "judge-model",
  calls: 1,
  usage: { tokens: 1200, costUsd: 0.05 },
  packed: {
    files: ["src/a.js"],
    omitted: [],
    lines: new Map(),
    agents: null,
    constraints: null,
  },
} as Tier2Result;

describe(
  "R-28: a head with a judged tree carries the verdict",
  { timeout: 30_000 },
  () => {
    it("writes the verdict and tree into the review marker, and reads them back", async () => {
      const { tree } = await mergedHead();
      const body = renderReview(approved, 1, "approve", { tree });
      expect(readMarker(body)).toEqual({
        round: 1,
        verdict: "approve",
        tree,
        carried: false,
      });
      // Reviews from before the marker had them: the heading still says the verdict.
      expect(
        readMarker(
          "<!-- rivetari-judge-review round=2 -->\n### Rivetari judge · round 2 · 1 blocking",
        ),
      ).toMatchObject({ round: 2, verdict: "request-changes", tree: null });
    });

    it("carries the PR's earlier review to a merge head with the same tree", async () => {
      const { dir, judged, merge, tree } = await mergedHead();
      const earlier = renderReview(approved, 1, "approve", { tree });
      const marked = [
        {
          review: {
            commit_id: judged,
            body: earlier,
            html_url: "https://x/r/1",
          },
          mark: readMarker(earlier)!,
        },
      ];
      const carried = await carriedFor(
        { repoPath: dir, ai: {} as never },
        marked,
        merge,
        tree,
      );
      expect(carried).toMatchObject({
        verdict: "approve",
        from: judged,
        source: "review round 1 on this PR",
      });
      const body = renderCarried(carried!, 1, tree);
      expect(readMarker(body)).toMatchObject({ carried: true, tree });
      expect(body).toContain(`Carried from \`${judged.slice(0, 12)}\``);
      expect(body).toContain("is identical to the one reviewed there");
    });

    it("matches an older marker without a tree by the reviewed commit's tree", async () => {
      const { dir, judged, merge, tree } = await mergedHead();
      const old =
        "<!-- rivetari-judge-review round=1 -->\n### Rivetari judge · round 1 · approve";
      const carried = await carriedFor(
        { repoPath: dir, ai: {} as never },
        [
          {
            review: { commit_id: judged, body: old, html_url: "u" },
            mark: readMarker(old)!,
          },
        ],
        merge,
        tree,
      );
      expect(carried?.from).toBe(judged);
    });

    it("reviews anew once the head has its own review, and falls back to the task judge", async () => {
      const { dir, judged, merge, tree } = await mergedHead();
      const earlier = renderReview(approved, 1, "approve", { tree });
      const own = { commit_id: merge, body: earlier, html_url: "u" };
      expect(
        await carriedFor(
          { repoPath: dir, ai: {} as never },
          [{ review: own, mark: readMarker(earlier)! }],
          merge,
          tree,
        ),
      ).toBeNull();
      const fromJudge = await carriedFor(
        {
          repoPath: dir,
          ai: {} as never,
          findJudged: async (t) =>
            t === tree
              ? {
                  verdict: "approve",
                  from: judged,
                  source: "T-0024's judge, round 1",
                  round: 1,
                  body: "ok",
                }
              : null,
        },
        [],
        merge,
        tree,
      );
      expect(fromJudge?.source).toBe("T-0024's judge, round 1");
    });
  },
);
