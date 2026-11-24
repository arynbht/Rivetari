import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { computeGates } from "./gates";

// Gates names the profile's phase as the current one and keeps the phase it
// infers from the controls apart, so the two can't be mistaken for each other.
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
  repo = mkdtempSync(join(tmpdir(), "rivetari-desktop-gates-"));
  cpSync(FIXTURE, repo, { recursive: true });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

async function declarePhase(phase: string): Promise<void> {
  const profile = join(repo, ".rivetari", "profile.yml");
  const text = await readFile(profile, "utf8");
  await writeFile(
    profile,
    text.replace("flags: {}", `phase: ${phase}\nflags: {}`),
  );
}

describe("computeGates declared phase", () => {
  it("reports the profile's phase as declared, apart from the inferred one", async () => {
    await declarePhase("build");
    const report = await computeGates(repo);

    expect(report.declaredPhase).toBe("build");
    const declared = report.phases.filter((p) => p.declared);
    expect(declared.map((p) => p.phase)).toEqual(["build"]);

    // The sample repo fails discovery's gate, so inference lands earlier than
    // the declared phase; both are reported, each on its own flag.
    expect(report.inferredPhase).toBe("discovery");
    expect(report.phases.find((p) => p.phase === "discovery")?.declared).toBe(
      false,
    );
  });

  it("reports no declared phase when the profile has none", async () => {
    const report = await computeGates(repo);
    expect(report.declaredPhase).toBe(null);
    expect(report.phases.some((p) => p.declared)).toBe(false);
  });
});
