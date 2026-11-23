import { describe, expect, it } from "vitest";

import { ProfileSchema } from "./profile.js";

const base = {
  version: 1,
  name: "sample",
  type: "web-app",
};

describe("ProfileSchema proof.auth", () => {
  it("accepts a sign-in script beside the start command and keeps it", () => {
    const profile = ProfileSchema.parse({
      ...base,
      proof: {
        start: "npm run dev",
        ready_timeout: 180,
        auth: { script: ".rivetari/proof-auth.mjs" },
      },
    });
    expect(profile.proof?.auth).toEqual({ script: ".rivetari/proof-auth.mjs" });
  });

  it("still loads a proof block without it", () => {
    expect(
      ProfileSchema.parse({ ...base, proof: { start: "npm run dev" } }).proof
        ?.auth,
    ).toBeUndefined();
  });

  it("rejects an auth block with no script, an empty one, or an unknown key", () => {
    for (const auth of [
      {},
      { script: "" },
      { script: "auth.mjs", state: "state.json" },
      "auth.mjs",
    ])
      expect(
        ProfileSchema.safeParse({ ...base, proof: { start: "x", auth } })
          .success,
      ).toBe(false);
  });
});
