import * as registry from "@arynbht/rivetari-registry";
import { describe, expect, it } from "vitest";

import * as runtime from "../index.js";
import { parseAssembly } from "./task-route.js";

// What the shell shows a person before they approve a route: the assembly as
// written, or why it can't be read. The repo checks stay with approveRoute.

const ASSEMBLY = [
  "task: T-0001",
  "sectors: [ui]",
  "phases: [build]",
  "skills: []",
  "budget: { skill_tokens: 0, context_tokens: 4000, steps: 30 }",
  "checks: [quality.lint.clean]",
  "proof: ui-screenshots",
  "review: { rubric: default, design_pass: true, security: false }",
  "stop_and_ask: [new_dependency]",
  "gaps: [no vendored skill covers motion]",
  "",
].join("\n");

describe("reading an assembly to show it", () => {
  it("reads a well-formed assembly, defaults and all", () => {
    const { assembly, problems } = parseAssembly(ASSEMBLY);
    expect(problems).toEqual([]);
    expect(assembly).toMatchObject({
      task: "T-0001",
      sectors: ["ui"],
      spine: [],
      budget: { skill_tokens: 0, context_tokens: 4000, steps: 30 },
      checks: ["quality.lint.clean"],
      proof: "ui-screenshots",
      gaps: ["no vendored skill covers motion"],
    });
  });

  it("says why when it isn't YAML, or isn't an assembly", () => {
    expect(parseAssembly("sectors: [ui").problems[0]).toMatch(
      /^assembly.yml isn't valid YAML/,
    );
    const shapeless = parseAssembly("task: T-0001\nsectors: [nowhere]\n");
    expect(shapeless.assembly).toBeUndefined();
    expect(shapeless.problems).toEqual(
      expect.arrayContaining([expect.stringMatching(/^sectors\.0: /)]),
    );
  });
});

describe("the registry calls the shell reads skills through", () => {
  it("are the registry's own", () => {
    expect(runtime.readLock).toBe(registry.readLock);
    expect(runtime.readState).toBe(registry.readState);
    expect(runtime.skillsStatus).toBe(registry.skillsStatus);
  });
});
