// R-22: the judge's verification pass downgraded a real acceptance defect
// because "no A5 text is given, so it doesn't exist here". The reviewer had
// raised it as a defect tied to A5, and the gate only got the criteria for
// findings of kind "acceptance". Every gate prompt now carries the card's
// criteria in full, and a confirmed finding against a criterion unmeets it.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AiClient } from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import type { Card } from "../task/card.js";
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
  const dir = await mkdtemp(join(tmpdir(), "rivetari-r22-"));
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
  const base = await write({ "src/synth.ts": "export const x = 1;\n" });
  const head = await write({
    "src/synth.ts":
      "export function calibration(rate: number) {\n  return { expectedA100: 2.2, peakAt: 5 * rate };\n}\n",
  });
  return { dir, base, head };
}

const A5 =
  "Calibration recordings have expected A100 and midline values known exactly, and a test checks those expected values";

const CARD: Card = {
  id: "T-0012",
  title: "Synthetic signals",
  type: "feature",
  source: "prompt",
  description: "Generate synthetic breathing signals",
  acceptance: [
    { id: "A1", text: "generateSignal returns the samples", verify: "unit" },
    { id: "A5", text: A5, verify: "unit" },
  ],
  out_of_scope: [],
  touches: [],
  pages: [],
  constraints: [],
  risk: "low",
  owner: "t",
  created: "2026-11-24",
};

/** The T-0012 finding: a defect tied to A5, with A5 marked met beside it. */
const REVIEW = {
  findings: [
    {
      kind: "defect",
      file: "src/synth.ts",
      line: 2,
      acceptance_id: "A5",
      title: "expected A100 disagrees with the samples off the sample grid",
      repro: "calibration(12.5): the 5 s peak falls between samples",
    },
  ],
  acceptance: [
    { id: "A1", status: "met", note: "" },
    { id: "A5", status: "met", note: "the default timings pass" },
  ],
};

function reviewer(gate: (prompt: string) => unknown) {
  const gatePrompts: string[] = [];
  const ai: AiClient = {
    async complete(params) {
      const isGate = params.system?.startsWith(
        "You are checking one code-review finding",
      );
      if (isGate) gatePrompts.push(params.prompt);
      return {
        text: JSON.stringify(isGate ? gate(params.prompt) : REVIEW),
        usage: { inputTokens: 10, outputTokens: 5 },
        model: params.model ?? "m",
      };
    },
  };
  return { ai, gatePrompts };
}

describe(
  "R-22: the gate sees the criteria a finding rests on",
  { timeout: 30_000 },
  () => {
    it("gives a defect tied to a criterion the criterion's full text", async () => {
      const r = await repoWithChange();
      // A gate that, like the pilot's, rejects a criterion it wasn't shown.
      const { ai, gatePrompts } = reviewer((prompt) =>
        prompt.includes(`- A5 (unit): ${A5}`)
          ? {
              reproducible: true,
              repro:
                "calibration(12.5) puts the first peak at sample 62.5, so no sample holds expectedA100",
            }
          : { reproducible: false, reason: "no A5 text is given" },
      );
      const result = await runTier2({
        repoPath: r.dir,
        base: r.base,
        head: r.head,
        ai,
        card: CARD,
      });
      expect(gatePrompts).toHaveLength(1);
      expect(gatePrompts[0]).toContain(`- A5 (unit): ${A5}`);
      expect(gatePrompts[0]).toContain("- A1 (unit): generateSignal returns");
      expect(result.blocking.map((f) => [f.kind, f.acceptance_id])).toEqual([
        ["defect", "A5"],
      ]);
      // A criterion with a confirmed defect against it isn't met.
      expect(result.acceptance.find((a) => a.id === "A5")).toMatchObject({
        status: "unmet",
      });
      expect(result.verdict).toBe("request-changes");
    });

    it("tells the gate when there is no card, so it judges the code alone", async () => {
      const r = await repoWithChange();
      const { ai, gatePrompts } = reviewer(() => ({
        reproducible: true,
        repro: "calibration(12.5) puts the first peak between two samples",
      }));
      await runTier2({ repoPath: r.dir, base: r.base, head: r.head, ai });
      expect(gatePrompts[0]).toContain("There is no task card for this change");
    });
  },
);
