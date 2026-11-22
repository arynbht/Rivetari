import { describe, expect, it } from "vitest";

import { looksLikeSecret } from "./redact.js";

describe("looksLikeSecret", () => {
  it("flags a generic secret assignment by default", () => {
    expect(looksLikeSecret('secret: "aaaaaaaaaaaa"')).toBe(true);
  });

  it("can skip the generic assignment rule, for test files that name secrets as data", () => {
    const fixture = 'expect(line).toBe(`secret: ${"z".repeat(119)}`);';
    expect(looksLikeSecret('secret: "aaaaaaaaaaaa"', { generic: false })).toBe(
      false,
    );
    expect(looksLikeSecret(fixture, { generic: false })).toBe(false);
  });

  it("still flags a provider-shaped key without the generic rule", () => {
    expect(
      looksLikeSecret('const key = "AKIAIOSFODNN7EXAMPLE";', {
        generic: false,
      }),
    ).toBe(true);
    expect(
      looksLikeSecret("-----BEGIN RSA PRIVATE KEY-----", { generic: false }),
    ).toBe(true);
  });
});
