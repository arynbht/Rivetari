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
  dir = await mkdtemp(join(tmpdir(), "rivetari-router-docs-"));
  ({ manifests } = await loadManifests(dir));
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const DESCRIPTION =
  "Describe the settings page layout: the sidebar, the modal, each button component and the dark mode theme.";

const routeFor = (touches: string[], title = "Write up the settings") =>
  route({
    card: parseCard({
      id: "T-0002",
      title,
      type: "chore",
      description: DESCRIPTION,
      acceptance: [{ id: "A1", text: "It reads well", verify: "review" }],
      touches,
      risk: "low",
      owner: "dev@example.com",
      created: "2026-11-23",
    }),
    manifests,
    available: new Set(manifests.keys()),
    flags: { "public-facing": true },
    files: ["README.md", "docs/guide.md", "src/app/main.ts"],
    checks: ["quality.tests.pass"],
  });

describe("a card whose touches are all Markdown", () => {
  it("doesn't bring in ui or the browser proof on its wording", () => {
    const { assembly, scores } = routeFor(["README.md"]);
    expect(assembly.sectors).not.toContain("ui");
    expect(assembly.sectors).not.toContain("a11y");
    expect(assembly.proof).not.toBe("ui-screenshots");
    expect(assembly.spine).not.toContain("playwright-cli");
    expect(scores.find((s) => s.sector === "ui")).toBeUndefined();
  });

  it("ignores ui words in the title too, and docs/ paths count as docs", () => {
    const { assembly } = routeFor(
      ["docs/setup.txt", "CHANGELOG.md"],
      "Document the settings page redesign",
    );
    expect(assembly.sectors).not.toContain("ui");
    expect(assembly.proof).not.toBe("ui-screenshots");
  });
});

describe("a card with other touches, or none", () => {
  it("routes ui in on the same wording when it also touches code", () => {
    const { assembly } = routeFor(["docs/guide.md", "src/app/main.ts"]);
    expect(assembly.sectors).toContain("ui");
    expect(assembly.sectors).toContain("a11y");
    expect(assembly.proof).toBe("ui-screenshots");
  });

  it("routes ui in on the same wording when it has no touches", () => {
    const { assembly } = routeFor([]);
    expect(assembly.sectors).toContain("ui");
    expect(assembly.sectors).toContain("a11y");
    expect(assembly.proof).toBe("ui-screenshots");
  });
});
