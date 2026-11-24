// R-13: the judge passed a change whose acceptance criteria were unmet. Its
// verdict followed the review's blocking count, so the pilot's empty diff
// passed with A1–A3 unmet (each downgraded for naming a file the change
// didn't have) and A4 unverified. An unmet criterion always blocks, an
// unverified one is never a pass, and an empty change never passes a card.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AiClient, CompleteParams } from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import type { Card } from "../task/card.js";
import { roundVerdict } from "./review.js";
import { renderReview, runTier2, type Tier2Result } from "./tier2.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repoWithChange(
  base: Record<string, string>,
  change: Record<string, string> | null,
): Promise<{ dir: string; base: string; head: string }> {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-r13-"));
  made.push(dir);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  const write = async (files: Record<string, string> | null) => {
    for (const [path, contents] of Object.entries(files ?? {})) {
      await mkdir(join(dir, path, ".."), { recursive: true });
      await writeFile(join(dir, path), contents, "utf8");
    }
    await git.add(["-A"]);
    await git.commit("c", ["--no-verify", "--allow-empty"]);
    return (await git.revparse(["HEAD"])).trim();
  };
  const b = await write(base);
  const h = await write(change);
  return { dir, base: b, head: h };
}

function scripted(review: unknown, gate: unknown) {
  const calls: CompleteParams[] = [];
  const ai: AiClient = {
    async complete(params) {
      calls.push(params);
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
  return { ai, calls };
}

const CARD: Card = {
  id: "T-0010",
  title: "Playwright e2e",
  type: "feature",
  source: "prompt",
  description: "Add an e2e suite",
  acceptance: [
    { id: "A1", text: "@playwright/test is a devDependency", verify: "unit" },
    { id: "A2", text: "e2e/auth.ts signs in as a coach", verify: "unit" },
    { id: "A3", text: "npm run e2e runs e2e/smoke.spec.ts", verify: "e2e" },
  ],
  out_of_scope: [],
  touches: [],
  pages: [],
  constraints: [],
  risk: "medium",
  owner: "t",
  created: "2026-11-24",
};

const BASE = { "src/a.js": "export const a = 1;\n" };
const CHANGE = { "src/a.js": "export const a = 2;\n" };

describe(
  "R-13: the verdict follows the acceptance criteria",
  { timeout: 30_000 },
  () => {
    it("blocks on unmet criteria whose findings name files outside the diff", async () => {
      const r = await repoWithChange(BASE, CHANGE);
      // The pilot's T-0010 review, as the reviewer answered it.
      const { ai, calls } = scripted(
        {
          findings: [
            {
              kind: "acceptance",
              file: "playwright.config.ts",
              acceptance_id: "A1",
              title: "no @playwright/test devDependency",
            },
            {
              kind: "acceptance",
              file: "e2e/auth.ts",
              acceptance_id: "A2",
              title: "e2e/auth.ts is not in the change",
            },
          ],
          acceptance: [
            { id: "A1", status: "unmet", note: "no devDependency" },
            {
              id: "A2",
              status: "unmet",
              note: "e2e/auth.ts not in the change",
            },
            { id: "A3", status: "unmet", note: "no spec committed" },
          ],
        },
        { reproducible: false, repro: "", reason: "nothing to trigger" },
      );
      const result = await runTier2({
        repoPath: r.dir,
        base: r.base,
        head: r.head,
        ai,
        card: CARD,
      });
      expect(result.verdict).toBe("request-changes");
      expect(result.blocking.map((f) => f.acceptance_id).sort()).toEqual([
        "A1",
        "A2",
        "A3",
      ]);
      // No gate call for them: the gate only filters false positives.
      expect(calls).toHaveLength(1);
      expect(roundVerdict(result, 1)).toBe("request-changes");
    });

    it("never passes an empty change, and pays for no review of it", async () => {
      const r = await repoWithChange(BASE, null);
      const { ai, calls } = scripted({ findings: [], acceptance: [] }, {});
      const result = await runTier2({
        repoPath: r.dir,
        base: r.base,
        head: r.head,
        ai,
        card: CARD,
      });
      expect(calls).toHaveLength(0);
      expect(result.verdict).toBe("request-changes");
      expect(result.acceptance.map((a) => a.status)).toEqual([
        "unmet",
        "unmet",
        "unmet",
      ]);
      expect(result.acceptance[0]?.note).toMatch(/the change is empty/);
      expect(roundVerdict(result, 1)).toBe("request-changes");
    });

    it("leaves a change whose files were all held back to a person, not a pass", async () => {
      const r = await repoWithChange(BASE, {
        "pnpm-lock.yaml": "lockfileVersion: 9\n",
      });
      const { ai, calls } = scripted({ findings: [], acceptance: [] }, {});
      const result = await runTier2({
        repoPath: r.dir,
        base: r.base,
        head: r.head,
        ai,
        card: CARD,
      });
      expect(calls).toHaveLength(0);
      expect(result.acceptance.every((a) => a.status === "unverified")).toBe(
        true,
      );
      expect(roundVerdict(result, 1)).toBe("needs-human");
    });

    it("makes an approval with an unverified criterion need a person, with the reason", async () => {
      const r = await repoWithChange(BASE, CHANGE);
      const { ai } = scripted(
        {
          findings: [],
          acceptance: [
            { id: "A1", status: "met", note: "" },
            { id: "A2", status: "met", note: "" },
            { id: "A3", status: "unverified", note: "no e2e run in the proof" },
          ],
        },
        {},
      );
      const result = await runTier2({
        repoPath: r.dir,
        base: r.base,
        head: r.head,
        ai,
        card: CARD,
      });
      expect(result.verdict).toBe("approve");
      expect(result.unverified).toEqual([
        { id: "A3", note: "no e2e run in the proof" },
      ]);
      expect(roundVerdict(result, 1)).toBe("needs-human");
      expect(renderReview(result, 1, "needs-human")).toContain(
        "A3 (no e2e run in the proof)",
      );
    });

    it("counts a criterion the reviewer never reported as unverified", () => {
      const result = {
        verdict: "approve",
        blocking: [],
        suggestions: [],
        acceptance: [],
        unreviewed: [],
        unverified: [{ id: "A1", note: "the reviewer didn't report on it" }],
      } as unknown as Tier2Result;
      expect(roundVerdict(result, 1)).toBe("needs-human");
    });
  },
);
