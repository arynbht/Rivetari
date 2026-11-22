import { describe, expect, it } from "vitest";

import { diffRules } from "./diff-rules.js";
import { findProtected } from "./protected.js";

// Joined at runtime so this file's own added lines aren't suppressions.
const DISABLE = `// ${["eslint", "disable-next-line"].join("-")} no-console`;
const IGNORE = `// ${["@ts", "ignore"].join("-")}`;
const ONLY = `${["it", "only"].join(".")}("bundled", () => {});`;

const suppressionsCheck = (
  added: ReadonlyMap<string, string[]>,
  generated: ReadonlySet<string>,
) =>
  diffRules([], added, { generated }).find(
    (c) => c.id === "diff.no-new-suppressions",
  );

const BUNDLE = "packages/action/dist/index.js";
const generated = new Set([BUNDLE]);

describe("suppressions in generated files", () => {
  it("passes diff.no-new-suppressions and isn't protected when the only one is in a generated path", () => {
    const added = new Map([
      [BUNDLE, [`var a=1;${DISABLE}`, IGNORE, ONLY]],
      ["src/a.ts", ["a();"]],
    ]);
    expect(suppressionsCheck(added, generated)).toMatchObject({
      outcome: "pass",
      head: "green",
    });
    expect(findProtected([], added, false, generated)).toEqual([]);
  });

  it("still fails one added in a source file", () => {
    const added = new Map([
      [BUNDLE, [IGNORE]],
      ["src/b.ts", [DISABLE, "b();"]],
    ]);
    expect(suppressionsCheck(added, generated)).toMatchObject({
      outcome: "fail",
      message: `new suppressions or skipped tests: src/b.ts: ${DISABLE}`,
    });
    expect(findProtected([], added, false, generated)).toEqual([
      {
        reason: "suppression",
        path: "src/b.ts",
        detail: `adds a check suppression: ${DISABLE}`,
      },
    ]);
  });

  it("checks a dist file no one said was generated", () => {
    const added = new Map([[BUNDLE, [IGNORE]]]);
    expect(suppressionsCheck(added, new Set())?.outcome).toBe("fail");
    expect(findProtected([], added, false).map((f) => f.path)).toEqual([
      BUNDLE,
    ]);
  });
});
