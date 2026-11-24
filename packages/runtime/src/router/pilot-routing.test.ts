// The router on the BreathBand pilot's real cards (2026-11-24), with the
// pilot's lock and its repo-local ui-ux-pro-max manifest. Each case is a
// route the pilot got wrong: words in a description brought in sectors and
// skills the touched paths said nothing about.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadManifests,
  type Manifest,
  ManifestSchema,
} from "@arynbht/rivetari-registry";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

import { type Card, parseCard } from "../task/card.js";
import {
  MAX_TASK_SKILLS,
  reasonSummary,
  route,
  type RouteInput,
} from "./route.js";

const FIXTURES = fileURLToPath(
  new URL("../../test/fixtures/pilot-cards/", import.meta.url),
);

/** The pilot's skills.lock once its task skills were locked, all synced. */
const PILOT_LOCK = [
  "a11y-core",
  "accessibility-lead",
  "animate",
  "code-review-and-quality",
  "constraint-driven-development",
  "differential-review",
  "floorplan",
  "fp-check",
  "frontend-design",
  "impeccable",
  "improve-animations",
  "incremental-implementation",
  "insecure-defaults",
  "native-writing",
  "planning-and-task-breakdown",
  "playwright-cli",
  "review-animations",
  "shipping-and-launch",
  "skill-creator",
  "spec-driven-development",
  "test-driven-development",
  "ui-ux-pro-max",
  "webapp-testing",
];
/** The lock the pilot started on: the spine and nothing else (R-17). */
const SPINE_LOCK = [
  "code-review-and-quality",
  "constraint-driven-development",
  "differential-review",
  "fp-check",
  "incremental-implementation",
  "planning-and-task-breakdown",
  "playwright-cli",
  "shipping-and-launch",
  "skill-creator",
  "spec-driven-development",
  "test-driven-development",
  "webapp-testing",
];
/** Files the pilot's cards touch or name, as they were in the repo. */
const FILES = [
  "Dockerfile",
  "nginx.conf",
  "firebase.json",
  "README.md",
  "docs/PLAN.md",
  "src/app/globals.css",
  "src/app/cloud/console.css",
  "src/app/cloud/trends/page.tsx",
  "src/app/cloud/TrendsTab.tsx",
  "src/components/trendCharts.tsx",
  "src/lib/analysis/config.ts",
  "src/lib/analysis/config.test.ts",
  "src/lib/analysis/index.ts",
  "src/lib/domain/types.ts",
  "src/lib/domain/waveform.ts",
];

let manifests: Map<string, Manifest>;
let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "rivetari-router-pilot-"));
  ({ manifests } = await loadManifests(dir));
  const local = ManifestSchema.parse(
    parse(await readFile(join(FIXTURES, "ui-ux-pro-max.yml"), "utf8")),
  );
  manifests.set(local.name, local);
});
afterAll(() => rm(dir, { recursive: true, force: true }));

const card = async (id: string): Promise<Card> =>
  parseCard(parse(await readFile(join(FIXTURES, `${id}.yml`), "utf8")));

const routed = async (
  id: string,
  lock: readonly string[] = PILOT_LOCK,
  extra: Partial<RouteInput> = {},
) =>
  route({
    card: await card(id),
    manifests,
    available: new Set(lock),
    locked: new Set(lock),
    flags: { "public-facing": true, "has-users": true, "handles-pii": true },
    files: FILES,
    checks: ["quality.tests.pass"],
    ...extra,
  });

const MOTION_SKILLS = ["animate", "review-animations", "improve-animations"];

describe("T-0026: transition detection in a signal (R-18)", () => {
  it("routes to testing, with no motion sector and no animation skill", async () => {
    const { assembly, scores, borderline } = await routed("T-0026");
    expect(assembly.sectors).toEqual(["testing"]);
    for (const name of MOTION_SKILLS)
      expect(assembly.skills).not.toContain(name);
    expect(assembly.budget.skill_tokens).toBe(0);
    expect(scores.find((s) => s.sector === "motion")).toBeUndefined();
    expect(borderline).not.toContain("motion");
    expect(assembly.proof).toBe("test-run");
  });

  it("leaves the browser proof skills out of a unit-tested library card", async () => {
    const { assembly } = await routed("T-0026");
    expect(assembly.spine).toContain("test-driven-development");
    expect(assembly.spine).not.toContain("playwright-cli");
    expect(assembly.spine).not.toContain("webapp-testing");
  });

  it("decides motion out when the title says animation but the touches are a library", async () => {
    const t = await card("T-0026");
    const routing = route({
      card: {
        ...t,
        title: "Animate the transition detection per the Appendix",
      },
      manifests,
      available: new Set(PILOT_LOCK),
      locked: new Set(PILOT_LOCK),
      files: FILES,
      checks: ["quality.tests.pass"],
    });
    expect(routing.assembly.sectors).not.toContain("motion");
    expect(routing.decidedOut).toContain("motion");
    expect(routing.outReasons.motion).toBe("none of its touches is UI code");
    for (const name of MOTION_SKILLS)
      expect(routing.assembly.skills).not.toContain(name);
  });
});

describe("T-0014 and T-0016: a table on a page, not a database (R-18)", () => {
  it("T-0014 routes to ui and a11y, without data or legal", async () => {
    const { assembly } = await routed("T-0014");
    expect(assembly.sectors).toEqual(["ui", "a11y"]);
    expect(assembly.sectors).not.toContain("data");
    expect(assembly.sectors).not.toContain("legal");
    expect(assembly.proof).toBe("ui-screenshots");
  });

  it("T-0016 routes to ui, a11y and testing, without data or legal", async () => {
    const { assembly } = await routed("T-0016");
    expect([...assembly.sectors].sort()).toEqual(["a11y", "testing", "ui"]);
    expect(assembly.gaps).toEqual([]);
  });

  it("still counts table and column for data when a data path backs them", async () => {
    const t = await card("T-0014");
    const { assembly } = route({
      card: {
        ...t,
        touches: [...t.touches, "prisma/schema.prisma"],
      },
      manifests,
      available: new Set(PILOT_LOCK),
      flags: { "handles-pii": true },
      files: FILES,
      checks: ["quality.tests.pass"],
    });
    expect(assembly.sectors).toContain("data");
    expect(assembly.sectors).toContain("legal");
  });
});

describe("T-0006: a docs-only card (R-4)", () => {
  it("routes to docs alone, with the docs proof and no browser", async () => {
    const { assembly, borderline } = await routed("T-0006");
    expect(assembly.sectors).toEqual(["docs"]);
    expect(assembly.proof).toBe("docs-render");
    expect(assembly.skills).toEqual(["native-writing"]);
    expect(assembly.spine).not.toContain("playwright-cli");
    expect(assembly.spine).not.toContain("webapp-testing");
    // "deploy", "docker" and "Dockerfile" in the description no longer
    // bring infra in, or even leave it for the approver.
    expect(borderline).not.toContain("infra");
    expect(borderline).not.toContain("ui");
  });
});

describe("T-0007: a TypeScript library card with a new test (R-5)", () => {
  it("routes to testing from the test file its acceptance names under its touches", async () => {
    // The pilot ran it before src/lib/analysis/ existed: no file matched.
    const routing = await routed("T-0007", PILOT_LOCK, { files: [] });
    expect(routing.assembly.sectors).toEqual(["testing"]);
    expect(routing.assembly.proof).toBe("test-run");
    expect(routing.assembly.skills).toEqual([]);
    const testing = routing.scores.find((s) => s.sector === "testing");
    expect(testing?.reasons).toContain(
      "touches src/lib/analysis/config.test.ts",
    );
  });

  it("ignores a named file outside the card's touches", async () => {
    const t = await card("T-0007");
    const { assembly } = route({
      card: {
        ...t,
        acceptance: [
          {
            id: "A1",
            text: "src/other/thing.test.ts still passes",
            verify: "unit",
          },
        ],
      },
      manifests,
      available: new Set(PILOT_LOCK),
      files: [],
      checks: ["quality.tests.pass"],
    });
    expect(assembly.sectors).not.toContain("testing");
  });
});

describe("the skill cap counts what's left after removals (R-32)", () => {
  it("routes ui-ux-pro-max once frontend-design steps aside for impeccable", async () => {
    const { assembly, notes } = await routed("T-0016");
    expect(assembly.skills).toEqual([
      "a11y-core",
      "accessibility-lead",
      "impeccable",
      "ui-ux-pro-max",
    ]);
    expect(notes).toContain(
      "frontend-design left out: a critique skill is already in the assembly",
    );
    expect(
      notes.some((n) => n.includes(`past ${MAX_TASK_SKILLS} skills`)),
    ).toBe(false);
  });

  it("doesn't hold a place for a skill that couldn't load", async () => {
    const lock = PILOT_LOCK.filter((n) => n !== "impeccable");
    const { assembly, notes } = await routed("T-0016", lock);
    expect(assembly.skills).toEqual([
      "a11y-core",
      "accessibility-lead",
      "frontend-design",
      "ui-ux-pro-max",
    ]);
    expect(notes.some((n) => n.includes("past"))).toBe(false);
  });
});

describe("the route's reasons", () => {
  it("group the words by where they were found, and skip a skill path that repeats a touch", async () => {
    const { scores } = await routed("T-0014");
    const ui = scores.find((s) => s.sector === "ui");
    const summary = reasonSummary(ui?.reasons ?? []);
    expect(summary).toMatch(/^touches src\/app\/cloud\/\S+; /);
    expect(summary).not.toMatch(/skill \S+ triggers on src\//);
    expect(summary).toMatch(
      /"page" in the title; "[^;]+", "[^;]+" in the description/,
    );
  });
});

describe("a skill that matched but isn't locked (R-17)", () => {
  it("says so in the sector's gap, with the command that adds it", async () => {
    const { assembly, notes } = await routed("T-0014", SPINE_LOCK);
    expect(assembly.skills).toEqual([]);
    const source = manifests.get("impeccable")?.source;
    expect(assembly.gaps).toContain(
      `ui: impeccable matched but isn't locked: run \`rivetari skills add ${source}\``,
    );
    expect(assembly.gaps.find((g) => g.startsWith("a11y: "))).toMatch(
      /^a11y: accessibility-lead .*isn't locked: run `rivetari skills add /,
    );
    // The gap carries it; the note isn't repeated.
    expect(notes.some((n) => n.startsWith("impeccable matched"))).toBe(false);
    expect(
      assembly.gaps.some((g) => g.includes("no vendored skill covers it")),
    ).toBe(false);
  });

  it("tells a locked skill that didn't load apart from one that isn't locked", async () => {
    const { notes, assembly } = await routed("T-0014", SPINE_LOCK, {
      locked: new Set([...SPINE_LOCK, "impeccable"]),
    });
    expect([...notes, ...assembly.gaps].join("\n")).toContain(
      "impeccable matched but is locked but didn't load (blocked or not synced): run `rivetari skills sync`",
    );
  });

  it("names the skill a repo with no lock would need", async () => {
    const { assembly, notes } = await routed("T-0014", [], {
      locked: new Set(),
    });
    expect(notes[0]).toMatch(/^no skills are locked in this repo/);
    expect(assembly.gaps[0]).toMatch(
      /^ui: impeccable matched but isn't locked: run `rivetari skills add /,
    );
  });
});
