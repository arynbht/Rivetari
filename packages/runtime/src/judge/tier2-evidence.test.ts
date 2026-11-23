// What tier 2 is shown beyond the diff, and what it does with it: a fix card's
// "before" proof has to show the defect, and changed docs bring the files
// they cite (within the caps).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AiClient, CompleteParams } from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import type { ProofRecord } from "../proof/prove.js";
import type { Card } from "../task/card.js";
import { CITED_FILE_CAP, runTier2 } from "./tier2.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repoWithChange(
  base: Record<string, string>,
  change: Record<string, string>,
): Promise<{ dir: string; base: string; head: string }> {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-tier2-evidence-"));
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
  return { dir, base: await write(base), head: await write(change) };
}

function reviewer(reply: unknown) {
  const calls: CompleteParams[] = [];
  const ai: AiClient = {
    async complete(params) {
      calls.push(params);
      return {
        text: JSON.stringify(reply),
        usage: { inputTokens: 10, outputTokens: 5 },
        model: params.model ?? "m",
      };
    },
  };
  return { ai, calls };
}

const card = (extra: Partial<Card> = {}): Card => ({
  id: "T-0005",
  title: "Stop the pricing table overflowing on phones",
  type: "fix",
  source: "prompt",
  description: "At 375px the pricing table runs off the right edge.",
  acceptance: [
    {
      id: "A1",
      text: "the table fits at 375px with no sideways scroll",
      verify: "screenshot",
    },
    { id: "A2", text: "lint passes", verify: "unit" },
  ],
  out_of_scope: [],
  touches: ["src/pricing.css"],
  pages: ["/pricing"],
  constraints: [],
  risk: "low",
  owner: "dev@example.com",
  created: "2026-11-20",
  ...extra,
});

/** A UI proof whose before at 375px fits the viewport: no overflow to fix. */
const proof: ProofRecord = {
  task: "T-0005",
  kind: "ui-screenshots",
  passed: true,
  lines: ["screenshots: /pricing at sm/md/lg, before and after (6 images)"],
  shots: (["before", "after"] as const).map((side) => ({
    side,
    page: "/pricing",
    breakpoint: "sm",
    file: `/tmp/proof/${side}-1-pricing-sm.png`,
    status: 200,
    layout: { viewport: 375, scrollWidth: 375, overflowing: [] },
  })),
};

const CSS = {
  base: { "src/pricing.css": "table { width: 100%; }\n" },
  change: { "src/pricing.css": "table { width: 100%; max-width: 100vw; }\n" },
};

describe("tier 2 evidence", { timeout: 30_000 }, () => {
  it("marks a fix card's criterion unverified when its before proof doesn't show the defect", async () => {
    const r = await repoWithChange(CSS.base, CSS.change);
    const { ai, calls } = reviewer({
      findings: [],
      acceptance: [
        { id: "A1", status: "met", note: "max-width keeps it in" },
        { id: "A2", status: "met", note: "" },
      ],
      before: {
        shows_defect: false,
        note: "the before at sm is 375px wide with nothing past the edge",
        criteria: ["A1"],
      },
    });
    const result = await runTier2({
      repoPath: r.dir,
      ...r,
      ai,
      card: card(),
      proof,
    });
    const prompt = calls[0]?.prompt ?? "";
    expect(prompt).toContain("## The before proof");
    expect(prompt).toContain(
      "- before · /pricing at sm · HTTP 200 · before-1-pricing-sm.png · no sideways scroll (375px in a 375px viewport)",
    );
    expect(result.acceptance).toEqual([
      {
        id: "A1",
        status: "unverified",
        note: "the before proof doesn't show the defect: the before at sm is 375px wide with nothing past the edge",
      },
      { id: "A2", status: "met", note: "" },
    ]);
    expect(result.before?.shows_defect).toBe(false);
    expect(result.verdict).toBe("approve");
  });

  it("leaves every criterion unverified when the reviewer doesn't answer on the before", async () => {
    const r = await repoWithChange(CSS.base, CSS.change);
    const { ai } = reviewer({
      findings: [],
      acceptance: [
        { id: "A1", status: "met", note: "" },
        { id: "A2", status: "met", note: "" },
      ],
    });
    const result = await runTier2({
      repoPath: r.dir,
      ...r,
      ai,
      card: card(),
      proof,
    });
    expect(result.acceptance.map((a) => a.status)).toEqual([
      "unverified",
      "unverified",
    ]);
  });

  it("keeps a met criterion when the before shows the defect, and asks nothing of a feature card", async () => {
    const r = await repoWithChange(CSS.base, CSS.change);
    const met = {
      findings: [],
      acceptance: [
        { id: "A1", status: "met", note: "" },
        { id: "A2", status: "met", note: "" },
      ],
    };
    const shown = reviewer({
      ...met,
      before: { shows_defect: true, note: "scrolls to 612px", criteria: [] },
    });
    const fix = await runTier2({
      repoPath: r.dir,
      ...r,
      ai: shown.ai,
      card: card(),
      proof,
    });
    expect(fix.acceptance.every((a) => a.status === "met")).toBe(true);

    const feature = reviewer(met);
    const result = await runTier2({
      repoPath: r.dir,
      ...r,
      ai: feature.ai,
      card: card({ type: "feature" }),
      proof,
    });
    expect(feature.calls[0]?.prompt).not.toContain("## The before proof");
    expect(feature.calls[0]?.prompt).toContain("## The proof");
    expect(result.acceptance.every((a) => a.status === "met")).toBe(true);
    expect(result.before).toBeUndefined();
  });

  it("gives the reviewer the files a changed doc cites, within the caps", async () => {
    const big = (name: string) =>
      `// ${name}\n${"export const value = 1;\n".repeat(1200)}`;
    const r = await repoWithChange(
      {
        "src/router.ts": "export function route() { return 'sector'; }\n",
        "src/big1.ts": big("big1"),
        "src/big2.ts": big("big2"),
        "src/big3.ts": big("big3"),
        ".env": "TOKEN=abc\n",
      },
      {
        "DESIGN.md": [
          "# Design",
          "",
          "Routing lives in `src/router.ts:1`, see also `./src/big1.ts`, `src/big2.ts` and `src/big3.ts`.",
          "Secrets sit in `.env`; the old `src/gone.ts` was removed.",
          "",
        ].join("\n"),
      },
    );
    const { ai, calls } = reviewer({
      findings: [],
      acceptance: [{ id: "A1", status: "met", note: "" }],
    });
    const result = await runTier2({
      repoPath: r.dir,
      ...r,
      ai,
      card: card({
        type: "chore",
        touches: ["DESIGN.md"],
        acceptance: [
          { id: "A1", text: "DESIGN.md cites real files", verify: "review" },
        ],
      }),
    });
    const prompt = calls[0]?.prompt ?? "";
    expect(prompt).toContain("## Files the changed docs cite");
    expect(prompt).toContain(
      "### src/router.ts\n```\nexport function route() { return 'sector'; }\n",
    );
    // Each big file is cut at the per-file cap; the third goes past the total.
    expect(prompt).toContain(
      `### src/big1.ts (first ${CITED_FILE_CAP} characters)`,
    );
    expect(prompt).toContain(
      `### src/big2.ts (first ${CITED_FILE_CAP} characters)`,
    );
    expect(prompt).toContain(
      "### src/big3.ts\n(not shown: over the review's size cap for cited files)",
    );
    expect(prompt).not.toContain("// big3");
    // Sensitive and missing files are never shown.
    expect(prompt).not.toContain("### .env");
    expect(prompt).not.toContain("TOKEN=abc");
    expect(prompt).not.toContain("### src/gone.ts");
    expect(result.verdict).toBe("approve");
  });
});
