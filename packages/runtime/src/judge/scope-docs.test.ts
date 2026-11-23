import { describe, expect, it } from "vitest";

import { affectedScope, type WorkspaceGraph } from "./workspace.js";

const GRAPH: WorkspaceGraph = {
  rootDeps: ["vitest", "typescript"],
  packages: [
    { dir: "packages/engine", name: "@r/engine", deps: [] },
    { dir: "packages/cli", name: "@r/cli", deps: ["@r/engine"] },
    { dir: "packages/action", name: "@r/action", deps: ["@r/cli"] },
  ],
};

describe("affectedScope with changesets and docs", () => {
  it("doesn't widen to everything for a changeset beside a code change", () => {
    const scope = affectedScope(
      [
        "packages/cli/src/commands/init.ts",
        ".changeset/init-ignore-history.md",
      ],
      GRAPH,
    );
    expect(scope.kind).toBe("packages");
    if (scope.kind === "packages")
      expect(scope.dirs).toEqual(["packages/cli", "packages/action"]);
  });

  it("ignores root Markdown and docs/ beside a code change", () => {
    const scope = affectedScope(
      ["packages/cli/src/a.ts", "README.md", "docs/guide/start.md"],
      GRAPH,
    );
    expect(scope.kind).toBe("packages");
  });

  it("still checks everything when only a changeset or docs changed", () => {
    expect(affectedScope([".changeset/a.md"], GRAPH).kind).toBe("all");
    expect(affectedScope(["docs/a.md", "README.md"], GRAPH).kind).toBe("all");
  });

  it("still checks everything for a root config change beside code", () => {
    expect(
      affectedScope(["packages/cli/src/a.ts", "package.json"], GRAPH).kind,
    ).toBe("all");
  });

  it("treats Markdown inside a package as code", () => {
    const scope = affectedScope(["packages/cli/prompts/review.md"], GRAPH);
    expect(scope.kind).toBe("packages");
  });
});
