import { describe, expect, it } from "vitest";

import { PACKAGE } from "./index.js";

describe("@arynbht/rivetari-catalog", () => {
  it("exposes its package identifier", () => {
    expect(PACKAGE).toBe("@arynbht/rivetari-catalog");
  });
});
