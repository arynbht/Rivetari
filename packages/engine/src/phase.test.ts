import type { Gate } from "@arynbht/rivetari-catalog";
import { describe, expect, it } from "vitest";

import type { ControlResult } from "./evaluate.js";
import { inferPhase } from "./phase.js";

const result = (
  controlId: string,
  phase: string,
  status: ControlResult["status"],
  severity: ControlResult["severity"] = "medium",
  effort?: ControlResult["effort"],
): ControlResult =>
  ({
    controlId,
    title: controlId,
    lane: "testing",
    phase,
    severity,
    effort,
    status,
    detectors: [],
    durationMs: 0,
  }) as ControlResult;

const GATES: Gate[] = [
  {
    phase: "scaffold",
    title: "Scaffold gate",
    select: [{ phase: "scaffold" }],
  },
  {
    phase: "build",
    title: "Build gate",
    select: [{ phase: "scaffold" }, { phase: "build" }],
  },
  { phase: "harden", title: "Harden gate", select: [{ phase: "harden" }] },
] as Gate[];

describe("inferPhase", () => {
  it("puts the repo at the lowest phase whose gate isn't green", () => {
    const inference = inferPhase(GATES, [
      result("SCF-1", "scaffold", "pass"),
      result("BLD-1", "build", "fail", "low"),
      result("BLD-2", "build", "needs-evidence", "high"),
      result("HRD-1", "harden", "fail"),
    ]);
    expect(inference.inferredPhase).toBe("build");
    expect(inference.allGreen).toBe(false);
    // Blockers are the inferred gate's, most severe first.
    expect(inference.blockers.map((b) => b.controlId)).toEqual([
      "BLD-2",
      "BLD-1",
    ]);
    expect(inference.blockers[0]).toMatchObject({
      status: "needs-evidence",
      effort: "medium",
    });
  });

  it("lists every phase in order, with null for a gate that isn't defined", () => {
    const { phases } = inferPhase(GATES, [result("SCF-1", "scaffold", "pass")]);
    expect(phases[0]).toEqual({
      phase: "discovery",
      title: "Discovery",
      status: null,
    });
    expect(phases.find((p) => p.phase === "scaffold")?.status).toBe("green");
    // The harden gate selects nothing here, so it's undefined, not amber.
    expect(phases.find((p) => p.phase === "harden")?.status).toBeNull();
  });

  it("never infers a phase below the declared one", () => {
    const results = [
      result("SCF-1", "scaffold", "fail"),
      result("HRD-1", "harden", "fail", "critical"),
    ];
    expect(inferPhase(GATES, results).inferredPhase).toBe("scaffold");
    const floored = inferPhase(GATES, results, "harden");
    expect(floored.inferredPhase).toBe("harden");
    expect(floored.blockers.map((b) => b.controlId)).toEqual(["HRD-1"]);
  });

  it("is at the last phase with nothing blocking when every gate is green", () => {
    const inference = inferPhase(GATES, [
      result("SCF-1", "scaffold", "pass"),
      result("BLD-1", "build", "waived"),
      result("HRD-1", "harden", "n/a"),
    ]);
    expect(inference.allGreen).toBe(true);
    expect(inference.inferredPhase).toBe("operate");
    expect(inference.blockers).toEqual([]);
  });

  it("infers nothing when no gate selects a control", () => {
    const inference = inferPhase(GATES, []);
    expect(inference).toMatchObject({
      inferredPhase: null,
      allGreen: false,
      blockers: [],
    });
  });
});
