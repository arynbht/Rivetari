import { describe, expect, it } from "vitest";

import { ProfileSchema } from "./profile.js";

const base = {
  version: 1,
  name: "sample",
  type: "web-app",
};

describe("ProfileSchema ci", () => {
  it("accepts a monthly budget and trust_judge, and keeps them", () => {
    const profile = ProfileSchema.parse({
      ...base,
      ci: { budget_minutes_per_month: 2000, trust_judge: false },
    });
    expect(profile.ci).toEqual({
      budget_minutes_per_month: 2000,
      trust_judge: false,
    });
  });

  it("loads without a ci block, or with an empty one", () => {
    expect(ProfileSchema.parse(base).ci).toBeUndefined();
    expect(ProfileSchema.parse({ ...base, ci: {} }).ci).toEqual({});
  });

  it("rejects a budget that isn't a positive whole number, and unknown keys", () => {
    for (const ci of [
      { budget_minutes_per_month: 0 },
      { budget_minutes_per_month: -5 },
      { budget_minutes_per_month: 12.5 },
      { budget_minutes_per_month: "2000" },
      { trust_judge: "yes" },
      { budget: 2000 },
    ])
      expect(ProfileSchema.safeParse({ ...base, ci }).success).toBe(false);
  });
});
