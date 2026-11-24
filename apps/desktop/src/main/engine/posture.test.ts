import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { postureTrend, readPosture } from "./posture";

// Posture reads one recorded audit for both its scorecard and its phase lens,
// the trend from history.jsonl's posture rows, and the waivers and evidence on
// file, each flagged when it's past or close to its expiry.

const NOW = new Date("2026-11-24T12:00:00Z");

let repo = "";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rivetari-desktop-posture-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

async function write(name: string, text: string): Promise<void> {
  await mkdir(join(repo, ".rivetari"), { recursive: true });
  await writeFile(join(repo, ".rivetari", name), text);
}

const profile = (phase: string) =>
  `version: 1\nname: posture\ntype: cli\nstack: [typescript]\nflags: {}\nphase: ${phase}\n`;

const control = (
  id: string,
  status: string,
  lane: string,
  phase: string,
  severity: string,
) => ({ id, status, lane, phase, severity });

const STATE = {
  version: 1,
  generatedAt: "2026-11-23T09:00:00.000Z",
  controls: [
    control("ci.workflow.present", "pass", "cicd", "scaffold", "high"),
    control("ci.runs-on-pr", "pass", "cicd", "scaffold", "high"),
    control("ci.changelog-automated", "fail", "cicd", "build", "low"),
    control(
      "a11y.keyboard.manual-pass",
      "needs-evidence",
      "accessibility",
      "build",
      "high",
    ),
    control("ci.actions-pinned-sha", "fail", "cicd", "harden", "medium"),
    control(
      "product.discovery.brief",
      "fail",
      "product",
      "discovery",
      "medium",
    ),
  ],
};

describe("readPosture", () => {
  it("shows nothing recorded, and still lists the trend, before an audit", async () => {
    await write(
      "history.jsonl",
      `${JSON.stringify({ date: "2026-11-20", byLane: { cicd: { pass: 1, total: 2 } } })}\n`,
    );
    const posture = await readPosture(repo, NOW);
    expect(posture.scorecard).toBeNull();
    expect(posture.lens).toBeNull();
    expect(posture.trend).toHaveLength(1);
    expect(posture.problems).toEqual([]);
  });

  it("reads the scorecard and the lens from the one recorded audit", async () => {
    await write("state.json", JSON.stringify(STATE));
    await write("profile.yml", profile("scaffold"));

    const { scorecard, lens } = await readPosture(repo, NOW);
    expect(scorecard?.totals).toMatchObject({
      pass: 2,
      fail: 3,
      needsEvidence: 1,
      total: 6,
    });
    expect(scorecard?.generatedAt).toBe(STATE.generatedAt);

    // The profile says scaffold; its gate is green, so the controls put the
    // repo at build, and build's gate blockers are what stand before harden.
    expect(lens).toMatchObject({
      declaredPhase: "scaffold",
      inferredPhase: "build",
      nextPhase: "harden",
      allGreen: false,
    });
    expect(lens?.blockers.map((b) => [b.controlId, b.status])).toEqual([
      ["a11y.keyboard.manual-pass", "needs-evidence"],
      ["ci.changelog-automated", "fail"],
    ]);
    expect(lens?.phases.find((p) => p.phase === "scaffold")?.status).toBe(
      "green",
    );
    expect(lens?.phases.find((p) => p.phase === "build")?.status).toBe("red");
  });

  it("never puts the repo below the phase its profile declares", async () => {
    await write("state.json", JSON.stringify(STATE));
    await write("profile.yml", profile("harden"));
    const { lens } = await readPosture(repo, NOW);
    expect(lens?.inferredPhase).toBe("harden");
    expect(lens?.nextPhase).toBe("launch");
  });

  it("flags waivers and evidence that are past or near their expiry", async () => {
    await write(
      "waivers.yml",
      [
        "- control: ci.changelog-automated",
        "  reason: Changelog comes from release notes",
        "  owner: ann@example.com",
        "  created: 2026-06-01",
        "  expires: 2026-11-01",
        "- control: ci.actions-pinned-sha",
        "  reason: Pinned by Renovate next sprint",
        "  expires: 2026-12-10",
        "- control: product.discovery.brief",
        "  reason: Shipped product",
        "  expires: 2027-06-01",
        "",
      ].join("\n"),
    );
    await write(
      "evidence.yml",
      [
        "- control: a11y.keyboard.manual-pass",
        "  reviewer: bo@example.com",
        "  date: 2026-11-10",
        "  valid-for: 30d",
        "  note: Keyboard pass on the settings flow",
        "- control: a11y.screen-reader.pass",
        "  reviewer: bo@example.com",
        "  date: 2026-01-10",
        "  valid-for: 90d",
        "- control: a11y.ci.automated-checks",
        "  reviewer: cy@example.com",
        "  date: 2026-11-01",
        "  url: https://example.com/axe-report",
        "",
      ].join("\n"),
    );

    const { waivers, evidence, problems } = await readPosture(repo, NOW);
    expect(problems).toEqual([]);
    expect(waivers.map((w) => [w.control, w.state])).toEqual([
      ["ci.changelog-automated", "expired"],
      ["ci.actions-pinned-sha", "expiring"],
      ["product.discovery.brief", "active"],
    ]);
    expect(waivers[0]).toMatchObject({
      owner: "ann@example.com",
      created: "2026-06-01",
      expires: "2026-11-01",
    });
    expect(waivers[1]).toMatchObject({ owner: null, created: null });

    expect(evidence.map((e) => [e.control, e.state, e.expires])).toEqual([
      ["a11y.keyboard.manual-pass", "expiring", "2026-12-10"],
      ["a11y.screen-reader.pass", "expired", "2026-04-10"],
      ["a11y.ci.automated-checks", "active", null],
    ]);
    expect(evidence[2]).toMatchObject({
      reviewer: "cy@example.com",
      url: "https://example.com/axe-report",
    });
  });

  it("reports a waiver file that doesn't parse beside what still reads", async () => {
    await write("state.json", JSON.stringify(STATE));
    await write("waivers.yml", "- control: NOT AN ID\n  reason: x\n");
    const posture = await readPosture(repo, NOW);
    expect(posture.problems).toHaveLength(1);
    expect(posture.problems[0]).toMatch(/waivers\.yml is invalid/);
    expect(posture.waivers).toEqual([]);
    expect(posture.scorecard).not.toBeNull();
  });
});

describe("postureTrend", () => {
  it("draws status counts where a row has them, and pass of total where it doesn't", () => {
    const trend = postureTrend([
      {
        date: "2026-11-01",
        byLane: { cicd: { pass: 3, total: 5 }, docs: { pass: 1, total: 2 } },
      },
      {
        date: "2026-11-08",
        byLane: { cicd: { pass: 4, total: 5 } },
        summary: {
          pass: 4,
          fail: 2,
          needsEvidence: 1,
          waived: 0,
          skip: 0,
          na: 1,
          total: 8,
        },
      },
    ]);
    expect(trend).toEqual([
      {
        date: "2026-11-01",
        pass: 4,
        fail: null,
        needsEvidence: null,
        total: 7,
      },
      { date: "2026-11-08", pass: 4, fail: 2, needsEvidence: 1, total: 8 },
    ]);
  });

  it("keeps the latest snapshots when there are many", () => {
    const rows = Array.from({ length: 75 }, (_, i) => ({
      date: `2026-09-${String((i % 28) + 1).padStart(2, "0")}`,
      byLane: { cicd: { pass: i, total: 100 } },
    }));
    const trend = postureTrend(rows);
    expect(trend).toHaveLength(60);
    expect(trend.at(-1)?.pass).toBe(74);
  });
});
