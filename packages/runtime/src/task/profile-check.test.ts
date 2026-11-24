// Intake checks a card's criteria against the profile before any build is
// paid for (the pilot's R-7: T-0008 asked for a header comment under
// quality.no-new-comments, and the conflict surfaced only at the judge,
// after a $2.08 round).
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CardError } from "./card.js";
import { profileConflicts } from "./profile-check.js";
import { newTask } from "./tasks.js";

const made: string[] = [];
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-24T00:13:00Z") };

beforeEach(async () => {
  const config = await mkdtemp(join(tmpdir(), "rivetari-config-"));
  made.push(config);
  process.env.RIVETARI_CONFIG_DIR = config;
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repoWith(files: Record<string, string>): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "rivetari-intake-"));
  made.push(repo);
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  for (const [path, text] of Object.entries({
    "package.json": '{ "name": "demo" }\n',
    ...files,
  })) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  return repo;
}

const PROFILE = (quality: string) =>
  `version: 1\nname: breathband-console\ntype: web-app\nautonomy: review-at-pr\n${quality}`;
const NO_COMMENTS = PROFILE("quality:\n  no-new-comments: true\n");

// T-0008's card, as the pilot drafted it.
const T0008 = {
  title: "HTTP backend stub for a future Cloud Run API",
  type: "feature" as const,
  description: "Add a third backend kind, http, as a stub.",
  touches: [
    "src/lib/backend/http/**",
    "src/lib/backend/index.ts",
    "src/lib/backend/types.ts",
    ".env.example",
  ],
  acceptance: [
    {
      id: "A1",
      text: "src/lib/backend/http/index.ts exports createHttpBackend(), which throws an Error naming NEXT_PUBLIC_BACKEND=http and pointing to src/lib/backend/http/index.ts, as the firebase stub does",
      verify: "unit" as const,
    },
    {
      id: "A2",
      text: "The stub's header comment maps every AuthService and DataService method in src/lib/backend/types.ts to a proposed REST call (method and path) on a future Cloud Run API, states that auth is an open decision, and makes no network calls",
      verify: "review" as const,
    },
    {
      id: "A4",
      text: ".env.example lists http as an allowed NEXT_PUBLIC_BACKEND value, plus a commented placeholder for the future API base URL",
      verify: "review" as const,
    },
    {
      id: "A5",
      text: "No new dependency, no change to src/lib/backend/local/** or src/lib/backend/local/local.test.ts; npm run lint, typecheck, test and build pass",
      verify: "unit" as const,
    },
  ],
};

describe("intake against the profile", () => {
  it("refuses T-0008's header-comment criterion under no-new-comments, before anything is drafted", async () => {
    const repo = await repoWith({ ".rivetari/profile.yml": NO_COMMENTS });
    const { refuse, warn } = await profileConflicts(repo, T0008);
    expect(refuse).toHaveLength(1);
    expect(refuse[0]).toMatch(
      /^acceptance A2 asks for a code comment \("comment"\), but the profile sets quality\.no-new-comments/,
    );
    // A commented line in .env.example isn't code, so A4 is fine.
    expect(refuse.join(" ")).not.toContain("A4");
    expect(warn).toEqual([]);
    await expect(newTask(repo, T0008, by)).rejects.toThrow(CardError);
    await expect(
      readFile(join(repo, ".rivetari", "tasks", "T-0001", "card.yml")),
    ).rejects.toThrow();
  });

  it("drafts it with --force, and the ledger says so", async () => {
    const repo = await repoWith({ ".rivetari/profile.yml": NO_COMMENTS });
    const task = await newTask(repo, T0008, { ...by, force: true });
    expect(task.entries.map((e) => e.text)).toContainEqual(
      expect.stringMatching(
        /^drafted despite the profile \(--force\): acceptance A2 asks for a code comment/,
      ),
    );
  });

  it("accepts the same card where comments are allowed, and T-0011's redraft where they aren't", async () => {
    const open = await repoWith({ ".rivetari/profile.yml": PROFILE("") });
    expect(await profileConflicts(open, T0008)).toEqual({
      refuse: [],
      warn: [],
    });
    const strict = await repoWith({ ".rivetari/profile.yml": NO_COMMENTS });
    const t0011 = {
      ...T0008,
      acceptance: [
        {
          id: "A2",
          text: "src/lib/backend/http/index.ts exports HTTP_ROUTES mapping every AuthService and DataService method to a proposed REST call, and src/lib/backend/http/README.md explains how to activate it later; no code comments are added",
          verify: "review" as const,
        },
      ],
    };
    expect((await profileConflicts(strict, t0011)).refuse).toEqual([]);
    // T-0020's A4 removes a JSDoc line and adds no comment.
    const t0020 = {
      ...T0008,
      acceptance: [
        {
          id: "A4",
          text: "The private two-argument mean helper at scores.ts:60 and the stale JSDoc line at scores.ts:62 are removed. scores.ts has no new comment lines.",
          verify: "review" as const,
        },
      ],
    };
    expect((await profileConflicts(strict, t0020)).refuse).toEqual([]);
  });

  it("refuses a criterion that asks for what a banned pattern forbids", async () => {
    // Built from parts so this file doesn't add the call the pattern bans.
    const CALL = `${"ev"}al(`;
    const repo = await repoWith({
      ".rivetari/banned.json": JSON.stringify({
        version: 1,
        patterns: [
          {
            id: "no-eval",
            pattern: String.raw`(?<![\w.$])eval\s*\(`,
            files: "**/*.{js,ts}",
            why: "eval runs a string as code",
            source: "stack default: node",
          },
        ],
      }),
    });
    const card = {
      acceptance: [
        {
          id: "A1",
          text: `parse the rule with ${CALL}text) in src/rules.ts`,
          verify: "unit" as const,
        },
        {
          id: "A2",
          text: `no ${CALL} call remains in src/rules.ts`,
          verify: "unit" as const,
        },
      ],
      touches: [],
    };
    const { refuse } = await profileConflicts(repo, card);
    expect(refuse).toEqual([
      `acceptance A1 asks for \`${CALL}\`, which the banned pattern no-eval forbids (eval runs a string as code); reword it, or change .rivetari/banned.json`,
    ]);
  });

  it("warns, without refusing, about protected paths and existing tests a card names", async () => {
    const repo = await repoWith({ "src/total.test.ts": "test();\n" });
    const { refuse, warn } = await profileConflicts(repo, {
      acceptance: [
        {
          id: "A1",
          text: "add an e2e job to .github/workflows/ci.yml",
          verify: "review" as const,
        },
        {
          id: "A2",
          text: "update src/total.test.ts to cover an empty list",
          verify: "unit" as const,
        },
        {
          id: "A3",
          text: "no change to src/total.test.ts, which passes unchanged",
          verify: "unit" as const,
        },
        // T-0010's A2: a protected file named as a reference, not changed.
        {
          id: "A4",
          text: "e2e/auth.ts signs in with the same wait as .rivetari/proof-auth.mjs (copied, not imported)",
          verify: "unit" as const,
        },
      ],
      touches: ["eslint.config.js"],
    });
    expect(refuse).toEqual([]);
    expect(warn).toEqual([
      "acceptance A1 names .github/workflows/ci.yml, a protected path (CI or git hook configuration): the build stops to ask a person before it changes, and the judge marks the change as needing one",
      "acceptance A2 names src/total.test.ts, a test that already exists: changing it needs a person; a new test is the usual way",
      "touches names eslint.config.js, a protected path (lint, format or type-check configuration): the build stops to ask a person before it changes, and the judge marks the change as needing one",
    ]);
  });
});
