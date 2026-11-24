import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readScorecard, runAudit } from "./audit";

// Scorecard shows what state.json records, not a count of its own. The fixture is
// the e2e sample repo, copied so the audit can write its state into the copy.
const FIXTURE = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "e2e",
  "fixtures",
  "sample-repo",
);

let repo = "";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rivetari-desktop-audit-"));
  cpSync(FIXTURE, repo, { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

async function writeState(state: unknown): Promise<void> {
  await mkdir(join(repo, ".rivetari"), { recursive: true });
  await writeFile(join(repo, ".rivetari", "state.json"), JSON.stringify(state));
}

describe("readScorecard", () => {
  it("returns null when no audit has been recorded", async () => {
    expect(await readScorecard(repo)).toBe(null);
  });

  it("shows the recorded results and when they were recorded", async () => {
    await writeState({
      version: 1,
      generatedAt: "2026-11-23T02:17:38.576Z",
      summary: {
        pass: 1,
        fail: 2,
        needsEvidence: 0,
        waived: 0,
        skip: 0,
        na: 0,
        total: 3,
      },
      controls: [
        {
          id: "repo.readme.present",
          status: "pass",
          lane: "hygiene",
          phase: "discovery",
          severity: "low",
        },
        {
          id: "repo.license.present",
          status: "fail",
          lane: "hygiene",
          phase: "build",
          severity: "high",
        },
        // Recorded by a catalog that had a control this one doesn't.
        {
          id: "repo.retired-control",
          status: "fail",
          lane: "hygiene",
          phase: "build",
          severity: "low",
        },
      ],
    });

    const card = await readScorecard(repo);
    expect(card?.generatedAt).toBe("2026-11-23T02:17:38.576Z");
    expect(card?.totals).toEqual({
      pass: 1,
      fail: 2,
      needsEvidence: 0,
      waived: 0,
      skip: 0,
      na: 0,
      total: 3,
    });
    // Only the recorded controls appear: nothing is evaluated on the side.
    const controls = card?.lanes.flatMap((lane) => lane.controls) ?? [];
    expect(controls.map((c) => c.controlId)).toEqual([
      "repo.readme.present",
      "repo.license.present",
      "repo.retired-control",
    ]);
    const readme = controls.find((c) => c.controlId === "repo.readme.present");
    expect(readme?.title).toBe("README present");
    expect(readme?.rationale.length).toBeGreaterThan(0);
    const retired = controls.find(
      (c) => c.controlId === "repo.retired-control",
    );
    expect(retired?.title).toBe("repo.retired-control");
  });
});

describe("runAudit", () => {
  it("records state.json the way the CLI does and shows that record", async () => {
    const card = await runAudit(repo);

    const state = JSON.parse(
      await readFile(join(repo, ".rivetari", "state.json"), "utf8"),
    ) as {
      generatedAt: string;
      summary: Record<string, number>;
      controls: { id: string; status: string }[];
    };
    expect(card.totals).toEqual(state.summary);
    expect(card.generatedAt).toBe(state.generatedAt);
    // Grouped by lane, so compare as sets of id and status.
    const shown = card.lanes.flatMap((lane) => lane.controls);
    expect(shown.map((c) => `${c.controlId} ${c.status}`).sort()).toEqual(
      state.controls.map((c) => `${c.id} ${c.status}`).sort(),
    );

    // Reading it back later gives the same numbers.
    const again = await readScorecard(repo);
    expect(again?.totals).toEqual(card.totals);
  });

  it("leaves the committed coverage baseline alone", async () => {
    await mkdir(join(repo, "coverage"), { recursive: true });
    await writeFile(
      join(repo, "coverage", "coverage-summary.json"),
      JSON.stringify({ total: { lines: { pct: 90 } } }),
    );
    await runAudit(repo);
    await expect(
      readFile(join(repo, ".rivetari", "quality.json"), "utf8"),
    ).rejects.toThrow();
  });

  it("records every control, whatever the severity floor", async () => {
    const profile = join(repo, ".rivetari", "profile.yml");
    const text = await readFile(profile, "utf8");
    await writeFile(
      profile,
      text.replace("severity-floor: low", "severity-floor: critical"),
    );

    const card = await runAudit(repo);
    const severities = new Set(
      card.lanes.flatMap((lane) => lane.controls.map((c) => c.severity)),
    );
    expect(severities.has("low")).toBe(true);
  });
});
