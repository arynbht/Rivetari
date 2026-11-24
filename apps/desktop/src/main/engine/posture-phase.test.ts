import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readPhase, readPosture } from "./posture";

// Home's posture gate is Posture's phase lens read on its own: the same
// recorded audit and gates, so the two views can't disagree.

let repo = "";

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "rivetari-desktop-phase-"));
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

async function write(name: string, text: string): Promise<void> {
  await mkdir(join(repo, ".rivetari"), { recursive: true });
  await writeFile(join(repo, ".rivetari", name), text);
}

const STATE = {
  version: 1,
  generatedAt: "2026-11-23T09:00:00.000Z",
  controls: [
    ["ci.workflow.present", "pass", "cicd", "scaffold", "high"],
    ["ci.runs-on-pr", "pass", "cicd", "scaffold", "high"],
    ["ci.changelog-automated", "fail", "cicd", "build", "low"],
    ["ci.actions-pinned-sha", "fail", "cicd", "harden", "medium"],
  ].map(([id, status, lane, phase, severity]) => ({
    id,
    status,
    lane,
    phase,
    severity,
  })),
};

describe("readPhase", () => {
  it("is null before an audit is recorded", async () => {
    expect(await readPhase(repo, "build")).toBeNull();
  });

  it("reads the lens Posture reads, from the profile's declared phase", async () => {
    await write("state.json", JSON.stringify(STATE));
    await write(
      "profile.yml",
      "version: 1\nname: phase\ntype: cli\nstack: [typescript]\nflags: {}\nphase: scaffold\n",
    );
    const lens = await readPhase(repo, "scaffold");
    expect(lens).toMatchObject({
      declaredPhase: "scaffold",
      inferredPhase: "build",
      nextPhase: "harden",
      allGreen: false,
    });
    expect(lens).toEqual((await readPosture(repo)).lens);
  });
});
