// The context budget follows the card's risk: a low-risk card gets a smaller
// slice than medium and high ones.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests, type Manifest } from "@arynbht/rivetari-registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseCard } from "../task/card.js";
import { route } from "./route.js";

let manifests: Map<string, Manifest>;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rivetari-router-budget-"));
  ({ manifests } = await loadManifests(dir));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const assemblyFor = (risk: "low" | "medium" | "high") =>
  route({
    card: parseCard({
      id: "T-0001",
      title: "Fix the total query",
      type: "fix",
      description: "total should sum the order lines.",
      acceptance: [{ id: "A1", text: "total sums lines", verify: "unit" }],
      touches: ["src/total.ts"],
      risk,
      owner: "dev@example.com",
      created: "2026-11-23",
    }),
    manifests,
    available: new Set(),
    checks: ["quality.tests.pass"],
  }).assembly;

describe("the context budget", () => {
  it("is 15k tokens for a low-risk card", () => {
    expect(assemblyFor("low").budget.context_tokens).toBe(15_000);
  });

  it("stays 60k tokens for medium and high risk", () => {
    expect(assemblyFor("medium").budget.context_tokens).toBe(60_000);
    expect(assemblyFor("high").budget.context_tokens).toBe(60_000);
  });
});
