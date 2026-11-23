import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bundledManifestsDir, loadManifests } from "./repo.js";
import { licenseProblem } from "./schema.js";

describe("the floorplan manifest", () => {
  it("validates with the shipped set and pins a hashed commit", async () => {
    const { manifests, errors } = await loadManifests(
      join(bundledManifestsDir(), "__none__"),
    );
    expect(errors).toEqual([]);
    const m = manifests.get("floorplan");
    expect(m).toMatchObject({
      source: "haydenschmitty/floorplan/skills/floorplan",
      pin: "94f81b463b7617e06d873ac71323ce71644c8399",
      hash: "sha256:fb7d3dc5732816cb3b12c2ff853588c719a20d366e6920b9be2ac52ac2763f28",
      license: "MIT",
      scope: "task",
      sectors: ["docs", "workflow"],
      phases: ["intake", "brief"],
      tools: ["shell"],
    });
    expect(licenseProblem(m!)).toBeNull();
  });
});
