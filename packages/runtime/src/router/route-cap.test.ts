// The critique fallback and the four-skill cap: frontend-design steps aside
// only for a critique skill that still fits once the cap has run.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadManifests, type Manifest } from "@arynbht/rivetari-registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseCard } from "../task/card.js";
import { route } from "./route.js";

let shipped: Map<string, Manifest>;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rivetari-router-cap-"));
  ({ manifests: shipped } = await loadManifests(dir));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

/**
 * UI skills that trigger on a .tsx touch and on the given words; a skill
 * given no words and no path (`null`) only comes in as a requirement.
 */
function uiSkills(
  keywords: Record<string, string[] | null>,
  requires: Record<string, string[]> = {},
): Map<string, Manifest> {
  const base = shipped.get("frontend-design");
  const impeccable = shipped.get("impeccable");
  if (!base || !impeccable) throw new Error("missing shipped manifests");
  const made = new Map<string, Manifest>();
  for (const [name, words] of Object.entries(keywords)) {
    const from = name === "impeccable" ? impeccable : base;
    made.set(name, {
      ...from,
      name,
      conflicts: [],
      requires: requires[name] ?? [],
      triggers: {
        paths: words === null ? [] : ["**/*.tsx"],
        keywords: words ?? [],
        flags: [],
      },
    });
  }
  return made;
}

const routeWith = (manifests: Map<string, Manifest>) =>
  route({
    card: parseCard({
      id: "T-0001",
      title: "Fix the settings panel",
      type: "fix",
      description: "The alpha and beta states render wrong.",
      acceptance: [{ id: "A1", text: "Both states render", verify: "e2e" }],
      touches: ["src/app/settings/Panel.tsx"],
      risk: "low",
      owner: "dev@example.com",
      created: "2026-11-24",
    }),
    manifests,
    available: new Set(manifests.keys()),
    checks: ["quality.tests.pass"],
  });

describe("the critique fallback under the cap", () => {
  it("keeps frontend-design when the cap cuts the critique skill", () => {
    const { assembly, notes } = routeWith(
      uiSkills({
        "skill-a": ["alpha", "beta"],
        "skill-b": ["alpha", "beta"],
        "skill-c": ["alpha", "beta"],
        "frontend-design": ["alpha"],
        "skill-z": ["alpha"],
        impeccable: [],
      }),
    );
    expect(assembly.skills).toEqual([
      "skill-a",
      "skill-b",
      "skill-c",
      "frontend-design",
    ]);
    expect(notes.some((n) => n.includes("a critique skill is already"))).toBe(
      false,
    );
    expect(notes).toContain(
      "impeccable left out: it would take the assembly past 4 skills",
    );
  });

  it("never keeps a skill without a requirement the cap cut with another", () => {
    const { assembly, notes } = routeWith(
      uiSkills(
        {
          "skill-a": ["alpha", "beta"],
          "skill-b": ["alpha", "beta"],
          "skill-c": ["alpha", "beta"],
          "skill-d": ["alpha"],
          "skill-e": ["alpha"],
          "shared-core": null,
        },
        { "skill-d": ["shared-core"], "skill-e": ["shared-core"] },
      ),
    );
    expect(assembly.skills).toEqual(["skill-a", "skill-b", "skill-c"]);
    expect(notes).toEqual([
      "skill-d left out: it would take the assembly past 4 skills",
      "skill-e left out: it would take the assembly past 4 skills",
    ]);
  });

  it("drops frontend-design for a critique skill that fits", () => {
    const { assembly, notes } = routeWith(
      uiSkills({
        "skill-a": ["alpha", "beta"],
        "frontend-design": ["alpha"],
        impeccable: [],
      }),
    );
    expect(assembly.skills).toEqual(["skill-a", "impeccable"]);
    expect(notes).toContain(
      "frontend-design left out: a critique skill is already in the assembly",
    );
  });
});
