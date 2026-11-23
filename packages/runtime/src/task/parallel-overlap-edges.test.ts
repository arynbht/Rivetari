import { describe, expect, it } from "vitest";

import { touchesOverlap } from "./parallel.js";

// Touches that could name any file in the repo must wait for every other card:
// running two cards on one file costs a conflict, waiting only costs time.
const OTHERS = [
  ["src/a.ts"],
  ["packages/runtime/src/task/run.ts"],
  ["docs/**"],
  ["**/*.test.ts"],
  ["README.md"],
];

describe("touches that could name any file", () => {
  for (const touch of [
    ".",
    "./",
    "/",
    "C:\\Users\\x\\a.ts",
    "D:/work/a.ts",
    "\\\\server\\share\\a.ts",
    "../**",
    "../other/a.ts",
    "src/../../x.ts",
  ]) {
    it(`treats ${JSON.stringify(touch)} as overlapping every other card`, () => {
      for (const other of OTHERS) {
        expect(touchesOverlap([touch], other)).toBe(true);
        expect(touchesOverlap(other, [touch])).toBe(true);
      }
    });
  }

  it("still keeps two plain relative paths apart", () => {
    expect(touchesOverlap(["src/a.ts"], ["src/b.ts"])).toBe(false);
  });

  it("reads a leading slash as repo-rooted, as .gitignore does", () => {
    expect(touchesOverlap(["/src/app"], ["src/app/page.tsx"])).toBe(true);
    expect(touchesOverlap(["/src/app"], ["docs/a.md"])).toBe(false);
  });
});
