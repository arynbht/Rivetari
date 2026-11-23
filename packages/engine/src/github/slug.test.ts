import { describe, expect, it } from "vitest";

import { parseRepoSlug } from "./slug.js";

describe("parseRepoSlug", () => {
  it("parses HTTPS remotes", () => {
    expect(parseRepoSlug("https://github.com/arynbht/rivetari.git")).toEqual({
      owner: "arynbht",
      repo: "rivetari",
    });
    expect(parseRepoSlug("https://github.com/arynbht/rivetari")).toEqual({
      owner: "arynbht",
      repo: "rivetari",
    });
  });

  it("parses SSH remotes", () => {
    expect(parseRepoSlug("git@github.com:arynbht/rivetari.git")).toEqual({
      owner: "arynbht",
      repo: "rivetari",
    });
  });

  it("parses ssh:// remotes", () => {
    expect(parseRepoSlug("ssh://git@github.com/arynbht/rivetari.git")).toEqual({
      owner: "arynbht",
      repo: "rivetari",
    });
  });

  it("returns null for non-GitHub or empty URLs", () => {
    expect(parseRepoSlug(undefined)).toBeNull();
    expect(parseRepoSlug("https://gitlab.com/a/b.git")).toBeNull();
  });

  it("rejects look-alike hosts (host not anchored)", () => {
    expect(parseRepoSlug("https://evilgithub.com/attacker/repo")).toBeNull();
    expect(
      parseRepoSlug("https://github.com.evil.com/attacker/repo"),
    ).toBeNull();
    expect(parseRepoSlug("https://notgithub.com/a/b.git")).toBeNull();
  });

  it("returns null for a non-bare URL with extra path segments", () => {
    expect(
      parseRepoSlug("https://github.com/arynbht/rivetari/tree/main"),
    ).toBeNull();
  });
});
