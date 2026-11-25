import { describe, expect, it } from "vitest";

import { registeredRepo } from "./registered";

// main decides which repo a request is about from its own registered list:
// the renderer's path only picks one of them, and names nothing else.

const repos = [
  { path: "C:\\Projects\\alpha", name: "alpha" },
  { path: "/home/ann/beta", name: "beta" },
];

describe("registeredRepo", () => {
  it("hands back the registered entry's own path", () => {
    expect(registeredRepo("/home/ann/beta", repos, "linux")).toBe(
      "/home/ann/beta",
    );
    expect(registeredRepo("/home/ann/beta/", repos, "linux")).toBe(
      "/home/ann/beta",
    );
  });

  it("matches Windows paths without regard to case", () => {
    expect(registeredRepo("c:\\projects\\ALPHA", repos, "win32")).toBe(
      "C:\\Projects\\alpha",
    );
  });

  it("refuses a path that isn't registered", () => {
    expect(() => registeredRepo("/home/ann/other", repos, "linux")).toThrow(
      "/home/ann/other isn't one of the registered repos",
    );
    // A path that climbs out of a registered repo isn't that repo.
    expect(() =>
      registeredRepo("/home/ann/beta/../other", repos, "linux"),
    ).toThrow(/isn't one of the registered repos/);
    // Nor is a folder inside one.
    expect(() =>
      registeredRepo("/home/ann/beta/.rivetari", repos, "linux"),
    ).toThrow(/isn't one of the registered repos/);
  });

  it("refuses a relative path, which would name wherever main runs", () => {
    expect(() => registeredRepo(".", repos, "linux")).toThrow(
      /isn't one of the registered repos/,
    );
  });

  it("refuses everything when nothing is registered", () => {
    expect(() => registeredRepo("/home/ann/beta", [], "linux")).toThrow(
      /isn't one of the registered repos/,
    );
  });
});
