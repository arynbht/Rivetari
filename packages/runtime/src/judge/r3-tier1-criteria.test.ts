// R-3: the reviewer never saw tier 1, so "npm run lint and typecheck pass"
// came back unverified every time though tier 1 had just run them green.
// Tier 1's results go into the review's prompt, and a criterion that only
// says its checks pass takes its status from them.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AiClient, CompleteParams } from "@arynbht/rivetari-engine";
import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import type { Card } from "../task/card.js";
import { tier1OnlyChecks, tier1Status } from "./tier1-criteria.js";
import { runTier2 } from "./tier2.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const LINT = "quality.lint.clean";
const TYPES = "quality.typecheck.clean";
const TESTS = "quality.tests.pass";

const green = [
  { id: LINT, title: "Lint passes", outcome: "pass" as const, message: "" },
  {
    id: TYPES,
    title: "Typecheck passes",
    outcome: "pass" as const,
    message: "",
  },
  { id: TESTS, title: "Tests pass", outcome: "pass" as const, message: "" },
];

describe("R-3: criteria tier 1 settles", () => {
  it("reads a criterion made only of 'these checks pass' clauses", () => {
    expect(tier1OnlyChecks("npm run lint and npm run typecheck pass")).toEqual([
      LINT,
      TYPES,
    ]);
    expect(
      tier1OnlyChecks("npm run lint, npm run typecheck and npm test pass."),
    ).toEqual([LINT, TYPES, TESTS]);
    expect(tier1OnlyChecks("`pnpm run lint`; tests still pass")).toBeNull();
    expect(tier1OnlyChecks("Lint, typecheck and tests pass")).toEqual([
      LINT,
      TYPES,
      TESTS,
    ]);
  });

  it("leaves a criterion that says more than tier 1 ran to the reviewer", () => {
    // From the pilot's cards.
    for (const text of [
      "src/lib/analysis/index.ts re-exports config; npm run lint and npm run typecheck pass",
      "npm run lint, typecheck, test and build pass",
      "npm run test passes with TZ=UTC and with TZ=Pacific/Auckland",
      "npm test (vitest) doesn't pick up e2e/ specs",
    ])
      expect(tier1OnlyChecks(text)).toBeNull();
  });

  it("marks met from green checks, and pre-existing red as unverified", () => {
    expect(tier1Status("lint and typecheck pass", green)?.status).toBe("met");
    expect(
      tier1Status("lint passes", [
        {
          id: LINT,
          title: "Lint passes",
          outcome: "pre-existing",
          message: "",
        },
      ]),
    ).toMatchObject({
      status: "unverified",
      note: expect.stringMatching(/pre-existing/),
    });
    // A check tier 1 didn't run settles nothing.
    expect(tier1Status("lint and tests pass", [green[0]!])).toBeNull();
  });
});

describe("R-3: tier 1 in the review", { timeout: 30_000 }, () => {
  it("shows the reviewer tier 1 and settles a lint/typecheck criterion as met", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rivetari-r3-"));
    made.push(dir);
    const git = simpleGit(dir);
    await git.init(["-b", "main"]);
    await git.addConfig("user.email", "t@t");
    await git.addConfig("user.name", "t");
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src/a.ts"), "export const a = 1;\n");
    await git.add(["-A"]);
    await git.commit("base", ["--no-verify"]);
    const base = (await git.revparse(["HEAD"])).trim();
    await writeFile(join(dir, "src/a.ts"), "export const a = 2;\n");
    await git.add(["-A"]);
    await git.commit("change", ["--no-verify"]);
    const head = (await git.revparse(["HEAD"])).trim();

    const calls: CompleteParams[] = [];
    const ai: AiClient = {
      async complete(params) {
        calls.push(params);
        // The pilot's answer for T-0007's A3.
        return {
          text: JSON.stringify({
            findings: [],
            acceptance: [
              { id: "A1", status: "met", note: "" },
              {
                id: "A2",
                status: "unverified",
                note: "lint and typecheck results aren't visible in the diff",
              },
            ],
          }),
          usage: { inputTokens: 1, outputTokens: 1 },
          model: "m",
        };
      },
    };
    const card: Card = {
      id: "T-0007",
      title: "Bump a",
      type: "chore",
      source: "prompt",
      description: "a is 2",
      acceptance: [
        { id: "A1", text: "a is 2", verify: "unit" },
        { id: "A2", text: "npm run lint and typecheck pass", verify: "unit" },
      ],
      out_of_scope: [],
      touches: [],
      pages: [],
      constraints: [],
      risk: "low",
      owner: "t",
      created: "2026-11-24",
    };
    const result = await runTier2({
      repoPath: dir,
      base,
      head,
      ai,
      card,
      tier1: green,
    });
    expect(calls[0]?.prompt).toContain("## Tier 1 (deterministic checks");
    expect(calls[0]?.prompt).toContain(
      "- quality.lint.clean (Lint passes): pass",
    );
    expect(result.acceptance.find((a) => a.id === "A2")).toMatchObject({
      status: "met",
      note: expect.stringMatching(/^tier 1 ran green/),
    });
    expect(result.unverified).toEqual([]);
  });
});
