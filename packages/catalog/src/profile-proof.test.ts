import { describe, expect, it } from "vitest";

import { ProfileSchema } from "./profile.js";

const base = {
  version: 1,
  name: "sample",
  type: "web-app",
};

const parses = (proof: unknown) =>
  ProfileSchema.safeParse({ ...base, proof }).success;

describe("ProfileSchema proof widths, readiness and docker", () => {
  it("keeps the widths, a ready map, the render timeout and a docker block", () => {
    const profile = ProfileSchema.parse({
      ...base,
      proof: {
        start: "npm run dev",
        widths: [375, 1024, 1440],
        ready: { "/cloud/trends": "[data-loaded]", "*": "main h1" },
        render_timeout: 45,
        docker: { port: 3000, path: "/health" },
      },
    });
    expect(profile.proof?.widths).toEqual([375, 1024, 1440]);
    expect(profile.proof?.ready).toEqual({
      "/cloud/trends": "[data-loaded]",
      "*": "main h1",
    });
    expect(profile.proof?.render_timeout).toBe(45);
    expect(profile.proof?.docker).toEqual({ port: 3000, path: "/health" });
  });

  it("takes one ready selector for every page", () => {
    expect(parses({ ready: "text=Session summary" })).toBe(true);
  });

  it("rejects widths that repeat, are empty, too narrow or not whole pixels", () => {
    for (const widths of [
      [375, 375],
      [],
      [100],
      [375.5],
      new Array(9).fill(0).map((_, i) => 400 + i),
    ])
      expect(parses({ widths })).toBe(false);
  });

  it("rejects an empty ready selector and a docker block with a bad port, path or key", () => {
    for (const proof of [
      { ready: "" },
      { ready: { "/": "" } },
      { docker: { port: 0 } },
      { docker: { port: 3000, path: "health" } },
      { docker: { image: "x" } },
    ])
      expect(parses(proof)).toBe(false);
  });
});
