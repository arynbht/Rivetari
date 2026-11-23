// `rivetari metrics` labels findings per PR as blocking only, and shows the
// suggestions on a line of their own.
import { describe, expect, it } from "vitest";

import { renderFindings } from "./metrics.js";

const metrics = {
  reviewed: 10,
  findings: 22,
  blocking: 1,
  suggestions: 21,
  findingsPerPr: 0.1,
  tier1Rules: { catalog: 5, diff: 3, total: 8 },
  patterns: [],
  candidates: [],
};

describe("renderFindings", () => {
  it("shows blocking findings per PR and the suggestions separately", () => {
    const lines = renderFindings(metrics).split("\n");
    expect(lines).toContain("  Blocking findings per PR  0.10");
    expect(lines).toContain(
      "  Suggestions               21 (2.1 per PR, not blocking)",
    );
    expect(lines.some((l) => /^ {2}Findings per PR/.test(l))).toBe(false);
  });

  it("says n/a with nothing reviewed", () => {
    const text = renderFindings({
      ...metrics,
      reviewed: 0,
      findings: 0,
      blocking: 0,
      suggestions: 0,
      findingsPerPr: null,
    });
    expect(text).toContain("  Blocking findings per PR  n/a");
    expect(text).toContain("  Suggestions               0\n");
  });
});
