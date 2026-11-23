import { describe, expect, it } from "vitest";

import { parseCard } from "../task/card.js";
import { DIFF_RULES, diffRules, isCommentLine } from "./diff-rules.js";
import { parseAddedLines, parseHunks } from "./tier1.js";

const card = (touches: string[]) =>
  parseCard({
    id: "T-0001",
    title: "Fix total",
    type: "fix",
    description: "d",
    acceptance: [{ id: "A1", text: "sums", verify: "unit" }],
    touches,
    owner: "dev@example.com",
    created: "2026-11-21",
  });

const byId = (checks: ReturnType<typeof diffRules>) =>
  Object.fromEntries(checks.map((c) => [c.id, c]));

describe("diff rules", () => {
  it("are three, and each answers for every change", () => {
    expect(DIFF_RULES.map((r) => r.id)).toEqual([
      "diff.no-new-comments",
      "diff.markdown-in-card",
      "diff.no-new-suppressions",
    ]);
    expect(diffRules([], new Map(), {})).toHaveLength(3);
  });

  it("tells comment lines from code", () => {
    expect(isCommentLine("a.ts", "  // why")).toBe(true);
    expect(isCommentLine("a.ts", "/** doc */")).toBe(true);
    expect(isCommentLine("a.ts", " * more doc")).toBe(true);
    expect(isCommentLine("a.ts", "const a = 2 * 3;")).toBe(false);
    expect(isCommentLine("a.py", "# why")).toBe(true);
    expect(isCommentLine("a.py", "#!/usr/bin/env python")).toBe(false);
    expect(isCommentLine("a.ts", "# not a comment in ts")).toBe(false);
  });

  it("fails new code comments when the repo turns the rule on, and is n/a otherwise", () => {
    const added = new Map([
      ["src/total.ts", ["// sums the list", "export const total = 1;"]],
      ["README.md", ["# Title"]],
    ]);
    const on = byId(
      diffRules([{ status: "M", path: "src/total.ts" }], added, {
        noNewComments: true,
      }),
    );
    expect(on["diff.no-new-comments"]).toMatchObject({
      outcome: "fail",
      head: "red",
      message: "new comments: src/total.ts: // sums the list",
    });
    const off = byId(diffRules([], added, {}));
    expect(off["diff.no-new-comments"]?.outcome).toBe("n/a");
  });

  it("doesn't count a reworded doc comment as new, but does a doc comment added beside it", () => {
    // T-0006's first round: writeReplacing's doc comment reworded, and a new
    // function with its own doc comment. Only the second is new.
    const unified = [
      "diff --git a/packages/cli/src/commands/init.ts b/packages/cli/src/commands/init.ts",
      "index 69f2d92..51df2fd 100644",
      "--- a/packages/cli/src/commands/init.ts",
      "+++ b/packages/cli/src/commands/init.ts",
      "@@ -136,3 +136,3 @@ async function keepBackup(",
      "- * Write a file Rivetari owns (`rivetari.yml`): a missing one is written, and",
      "- * with --force a different one is replaced, the old one kept as a backup.",
      "- * Returns a note when it replaced one.",
      "+ * Write a generated file under --force: a missing one is written, and a",
      "+ * different one is replaced, the old one kept as a backup. Returns a note when",
      "+ * it replaced one.",
      "@@ -167,0 +168,8 @@ async function writeBeside(",
      "+  return writeKeeping(root, rel, content);",
      "+}",
      "+",
      "+/**",
      "+ * Write a generated file and never replace one that's there.",
      "+ */",
      "+async function writeKeeping(",
      "+  root: string,",
      "",
    ].join("\n");
    const hunks = parseHunks(unified);
    expect(hunks.get("packages/cli/src/commands/init.ts")).toHaveLength(2);

    const on = byId(
      diffRules(
        [{ status: "M", path: "packages/cli/src/commands/init.ts" }],
        parseAddedLines(unified),
        { noNewComments: true, hunks },
      ),
    );
    expect(on["diff.no-new-comments"]).toMatchObject({
      outcome: "fail",
      message:
        "new comments: packages/cli/src/commands/init.ts: /**; packages/cli/src/commands/init.ts: * Write a generated file and never replace one that's there.; packages/cli/src/commands/init.ts: */",
    });

    const reworded = unified.split("@@ -167")[0] ?? "";
    expect(
      byId(
        diffRules(
          [{ status: "M", path: "packages/cli/src/commands/init.ts" }],
          parseAddedLines(reworded),
          { noNewComments: true, hunks: parseHunks(reworded) },
        ),
      )["diff.no-new-comments"]?.outcome,
    ).toBe("pass");
  });

  it("still fails a deleted comment swapped for an unrelated one", () => {
    const check = (unified: string) =>
      byId(
        diffRules(
          [{ status: "M", path: "src/total.ts" }],
          parseAddedLines(unified),
          { noNewComments: true, hunks: parseHunks(unified) },
        ),
      )["diff.no-new-comments"];
    const head = [
      "diff --git a/src/total.ts b/src/total.ts",
      "--- a/src/total.ts",
      "+++ b/src/total.ts",
    ];

    // Same hunk, but the removed comment was inside the function and the
    // added one is at the top level.
    expect(
      check(
        [
          ...head,
          "@@ -4,2 +4,3 @@ export function total(xs) {",
          "-  // An empty list sums to 0.",
          "-  return xs.reduce((a, b) => a + b, 0);",
          "+  return xs.reduce((a, b) => a + b, 0);",
          "+}",
          "+// Exported for the CLI.",
          "",
        ].join("\n"),
      ),
    ).toMatchObject({
      outcome: "fail",
      message: "new comments: src/total.ts: // Exported for the CLI.",
    });

    // Same indentation, but one hunk only deletes and another only adds.
    expect(
      check(
        [
          ...head,
          "@@ -4 +3,0 @@ export function total(xs) {",
          "-  // An empty list sums to 0.",
          "@@ -9,0 +9 @@ export function mean(xs) {",
          "+  // Rounds down.",
          "",
        ].join("\n"),
      ),
    ).toMatchObject({
      outcome: "fail",
      message: "new comments: src/total.ts: // Rounds down.",
    });
  });

  it("fails Markdown the card doesn't name, and passes what it does", () => {
    const diff = [
      { status: "A" as const, path: ".changeset/fix.md" },
      { status: "M" as const, path: "docs/notes.md" },
      { status: "D" as const, path: "old.md" },
    ];
    const named = byId(
      diffRules(diff, new Map(), {
        card: card([".changeset/*.md", "docs/notes.md"]),
      }),
    );
    expect(named["diff.markdown-in-card"]?.outcome).toBe("pass");
    const unnamed = byId(
      diffRules(diff, new Map(), { card: card(["src/total.ts"]) }),
    );
    expect(unnamed["diff.markdown-in-card"]).toMatchObject({
      outcome: "fail",
      message: "Markdown the card doesn't name: docs/notes.md",
    });
    const noCard = byId(diffRules(diff, new Map(), {}));
    expect(noCard["diff.markdown-in-card"]?.outcome).toBe("n/a");
  });

  it("skips Markdown under the profile's generated globs and .changeset/, but not an unnamed README.md", () => {
    const diff = [
      { status: "M" as const, path: "docs/catalog/x.md" },
      { status: "A" as const, path: ".changeset/y.md" },
    ];
    const options = {
      card: card(["src/total.ts"]),
      generatedGlobs: ["docs/catalog/**"],
    };
    expect(
      byId(diffRules(diff, new Map(), options))["diff.markdown-in-card"]
        ?.outcome,
    ).toBe("pass");
    expect(
      byId(
        diffRules(
          [...diff, { status: "M" as const, path: "README.md" }],
          new Map(),
          options,
        ),
      )["diff.markdown-in-card"],
    ).toMatchObject({
      outcome: "fail",
      message: "Markdown the card doesn't name: README.md",
    });
    expect(
      byId(diffRules(diff, new Map(), { card: card(["src/total.ts"]) }))[
        "diff.markdown-in-card"
      ],
    ).toMatchObject({
      outcome: "fail",
      message: "Markdown the card doesn't name: docs/catalog/x.md",
    });
  });

  it("fails new suppressions and skipped or focused tests, except where a person allowed one", () => {
    const added = new Map([
      ["src/a.ts", ["// eslint-disable-next-line no-console", "x();"]],
      ["src/b.test.ts", ['it.only("runs alone", () => {});']],
      ["src/c.test.ts", ['describe.skip("later", () => {});']],
      ["src/d.ts", ["// @ts-ignore", "y();"]],
      ["src/e.ts", ['const only = "it.only is just text here";']],
    ]);
    const result = byId(
      diffRules([], added, { allowedSuppressions: new Set(["src/d.ts"]) }),
    );
    expect(result["diff.no-new-suppressions"]).toMatchObject({
      outcome: "fail",
    });
    const message = result["diff.no-new-suppressions"]?.message ?? "";
    expect(message).toContain("src/a.ts: // eslint-disable-next-line");
    expect(message).toContain('src/b.test.ts: it.only("runs alone"');
    expect(message).toContain('src/c.test.ts: describe.skip("later"');
    expect(message).not.toContain("src/d.ts");
    expect(
      byId(diffRules([], new Map([["src/f.ts", ["f();"]]]), {}))[
        "diff.no-new-suppressions"
      ]?.outcome,
    ).toBe("pass");
  });
});
