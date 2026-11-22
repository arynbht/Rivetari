import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { parseCard } from "../task/card.js";
import { tier1Rules } from "./rules.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const card = parseCard({
  id: "T-0001",
  title: "Fix total",
  type: "fix",
  description: "d",
  acceptance: [{ id: "A1", text: "sums", verify: "unit" }],
  touches: ["src/total.ts", ".changeset/*.md"],
  owner: "dev@example.com",
  created: "2026-11-23",
});

async function repo(profileExtra: string, banned?: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "factory-rules-test-"));
  made.push(dir);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  await mkdir(join(dir, ".factory"), { recursive: true });
  await writeFile(
    join(dir, ".factory", "profile.yml"),
    `version: 1\nname: demo\ntype: library\nstack:\n  - typescript\nphase: build\nflags: {}\n${profileExtra}`,
    "utf8",
  );
  if (banned)
    await writeFile(
      join(dir, ".factory", "banned.json"),
      JSON.stringify(banned),
      "utf8",
    );
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  return dir;
}

describe("the tier 1 rules in the build prompt", () => {
  it("lists every enabled diff rule and banned pattern, one line each, from the profile and banned.json", async () => {
    const dir = await repo("quality:\n  no-new-comments: true\n", {
      version: 1,
      patterns: [
        {
          id: "no-eval",
          pattern: String.raw`(?<![\w.$])eval\s*\(`,
          files: "**/*.ts",
          allow: ["scripts/**"],
          why: "eval runs a string as code",
          source: "stack default: node",
        },
      ],
    });
    expect(await tier1Rules(dir, "HEAD", card)).toEqual([
      "diff.no-new-comments: The change adds no code comments.",
      "diff.markdown-in-card: Every Markdown file the change adds or edits is named in the card (the card names: src/total.ts, .changeset/*.md).",
      "diff.no-new-suppressions: The change adds no check suppressions or skipped tests.",
      String.raw`no-eval: nothing matching /(?<![\w.$])eval\s*\(/ in **/*.ts (allowed in scripts/**); eval runs a string as code.`,
    ]);
  }, 60_000);

  it("leaves out no-new-comments when the profile doesn't turn it on, and reads banned.json from the base", async () => {
    const dir = await repo("");
    await mkdir(join(dir, ".factory"), { recursive: true });
    await writeFile(
      join(dir, ".factory", "banned.json"),
      JSON.stringify({ version: 1, patterns: [] }),
      "utf8",
    );
    const rules = await tier1Rules(dir, "HEAD", card);
    expect(rules.map((r) => r.split(":")[0])).toEqual([
      "diff.markdown-in-card",
      "diff.no-new-suppressions",
    ]);
  }, 60_000);
});
