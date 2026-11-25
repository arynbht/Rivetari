// A new test that passes on the base proves nothing about the change, and the
// criterion it backs is unverified.
import { describe, expect, it } from "vitest";

import {
  aloneCommand,
  applyBaseTests,
  backedCriteria,
  type BaseTests,
  baseTestsSection,
  changedTests,
  provedNothing,
  testRunner,
} from "./base-tests.js";

const card = {
  acceptance: [
    {
      id: "A1",
      text: "New test src/lib/a.test.ts checks that a() rounds up",
      verify: "unit" as const,
    },
    { id: "A2", text: "b() returns 2", verify: "unit" as const },
    { id: "A3", text: "The page reads well", verify: "manual" as const },
  ],
};

const ran = (files: [string, "pass" | "fail"][]): BaseTests => ({
  status: "ran",
  note: "",
  files: files.map(([file, onBase]) => ({ file, onBase, command: "x" })),
});

describe("changedTests", () => {
  it("takes added tests and allowed changes to existing ones", () => {
    expect(
      changedTests(
        [
          { status: "A", path: "src/new.test.ts" },
          { status: "M", path: "src/old.test.ts" },
          { status: "M", path: "src/kept.test.ts" },
          { status: "D", path: "src/gone.test.ts" },
          { status: "A", path: "src/a.ts" },
        ],
        new Set(["src/kept.test.ts"]),
      ),
    ).toEqual(["src/new.test.ts", "src/kept.test.ts"]);
  });
});

describe("testRunner and aloneCommand", () => {
  it("knows vitest, jest and pytest, and nothing else", () => {
    expect(testRunner("npm test", "vitest run")).toBe("vitest");
    expect(testRunner("npm test", "tsc --build && vitest run")).toBe("vitest");
    expect(testRunner("npm test", "jest --ci")).toBe("jest");
    expect(testRunner("pytest -q", undefined)).toBe("pytest");
    expect(testRunner("go test ./...", undefined)).toBeNull();
    expect(testRunner("npm test", "mocha")).toBeNull();
  });

  it("runs one file alone with coverage off, replacing a scoped run's packages", () => {
    expect(aloneCommand("npm test", "src/a.test.ts", "vitest")).toEqual([
      "npm",
      "test",
      "--",
      "src/a.test.ts",
      "--coverage.enabled=false",
    ]);
    expect(
      aloneCommand(
        "npm test -- packages/x/ --passWithNoTests --coverage.enabled=false",
        "packages/x/a.test.ts",
        "vitest",
      ),
    ).toEqual([
      "npm",
      "test",
      "--",
      "packages/x/a.test.ts",
      "--coverage.enabled=false",
    ]);
    expect(aloneCommand("npm test", "a.test.ts", "jest")).toEqual([
      "npm",
      "test",
      "--",
      "a.test.ts",
      "--coverage=false",
    ]);
    expect(aloneCommand("pytest -q", "tests/test_a.py", "pytest")).toEqual([
      "pytest",
      "-q",
      "tests/test_a.py",
    ]);
  });
});

describe("backedCriteria", () => {
  it("maps a file to the criteria that name it, else to the unit criteria naming no test", () => {
    expect(
      Object.fromEntries(
        backedCriteria(card, ["src/lib/a.test.ts", "src/lib/b.test.ts"]),
      ),
    ).toEqual({ A1: ["src/lib/a.test.ts"], A2: ["src/lib/b.test.ts"] });
  });

  it("matches a criterion that names the file by its name alone", () => {
    expect(
      Object.fromEntries(
        backedCriteria(
          {
            acceptance: [
              { id: "A1", text: "a.test.ts covers rounding", verify: "unit" },
            ],
          },
          ["src/lib/a.test.ts"],
        ),
      ),
    ).toEqual({ A1: ["src/lib/a.test.ts"] });
  });
});

describe("applyBaseTests", () => {
  const met = [
    { id: "A1", status: "met" as const, note: "" },
    { id: "A2", status: "met" as const, note: "" },
    { id: "A3", status: "met" as const, note: "" },
  ];

  it("makes a criterion unverified when the test it names passes on the base", () => {
    const out = applyBaseTests(met, card, ran([["src/lib/a.test.ts", "pass"]]));
    expect(out.find((a) => a.id === "A1")).toEqual({
      id: "A1",
      status: "unverified",
      note: "src/lib/a.test.ts passes on the base too, so it proves nothing about this change",
    });
    expect(out.find((a) => a.id === "A2")?.status).toBe("met");
  });

  it("leaves criteria alone when every new test fails on the base", () => {
    expect(
      applyBaseTests(met, card, ran([["src/lib/a.test.ts", "fail"]])),
    ).toEqual(met);
  });

  it("keeps an unmet criterion unmet, and adds one the review didn't report", () => {
    const out = applyBaseTests(
      [{ id: "A1", status: "unmet" as const, note: "wrong" }],
      card,
      ran([["src/lib/a.test.ts", "pass"]]),
    );
    expect(out).toEqual([{ id: "A1", status: "unmet", note: "wrong" }]);
    expect(
      applyBaseTests([], card, ran([["src/lib/a.test.ts", "pass"]])),
    ).toEqual([
      {
        id: "A1",
        status: "unverified",
        note: "src/lib/a.test.ts passes on the base too, so it proves nothing about this change",
      },
    ]);
  });

  it("fails closed: tests that had to run on the base and couldn't leave their criteria unverified", () => {
    const out = applyBaseTests(met, card, {
      status: "not run",
      note: "the tests check didn't run on the change",
      files: [{ file: "src/lib/a.test.ts", onBase: "not run", command: "" }],
    });
    expect(out.find((a) => a.id === "A1")).toMatchObject({
      status: "unverified",
      note: "src/lib/a.test.ts couldn't be run on the base (the tests check didn't run on the change), so nothing shows it fails without this change",
    });
  });

  it("changes nothing for an exempt card", () => {
    expect(
      applyBaseTests(met, card, {
        status: "exempt",
        note: "a chore card is exempt",
        files: [],
      }),
    ).toEqual(met);
  });
});

describe("provedNothing and baseTestsSection", () => {
  it("lists the files that passed on the base and tells the reviewer", () => {
    const t = ran([
      ["a.test.ts", "pass"],
      ["b.test.ts", "fail"],
    ]);
    expect(provedNothing(t)).toEqual(["a.test.ts"]);
    expect(baseTestsSection(t).join("\n")).toContain(
      "- a.test.ts: passes on the base too: it proves nothing about this change",
    );
    expect(baseTestsSection(undefined)).toEqual([]);
  });
});
