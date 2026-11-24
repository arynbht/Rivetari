import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { type ProjectCheck, readRecords, withRunner } from "./project";
import { CHECK_EVERY_MS, ProjectChecks } from "./project-checks";

// Round 1 of the review: a proof.start moved to npm must still run, a
// profile.yml that won't load is said rather than shown as unset, and a repo
// forgotten while its check runs isn't held again when the check lands.

describe("withRunner", () => {
  it.each([
    ["yarn dev", "npm", "npm run dev"],
    ["pnpm dev --port 3000", "npm", "npm run dev --port 3000"],
    ["pnpm start", "npm", "npm start"],
    ["yarn run dev", "npm", "npm run dev"],
    ["pnpm exec vite", "npm", "npm exec vite"],
    ["pnpm dlx serve dist", "npm", "npx serve dist"],
    ["npm run dev", "pnpm", "pnpm run dev"],
    ["npm start", "yarn", "yarn start"],
  ] as const)("runs %s with %s as %s", (start, pm, to) => {
    expect(withRunner(start, pm)).toBe(to);
  });
});

describe("readRecords with a profile.yml that won't load", () => {
  let repo = "";
  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it("says so instead of showing proof and autonomy as unset", async () => {
    repo = await mkdtemp(join(tmpdir(), "rivetari-desktop-project-broken-"));
    await mkdir(join(repo, ".rivetari"), { recursive: true });
    await writeFile(
      join(repo, ".rivetari", "profile.yml"),
      "version: 1\nname: shop\ntype: web-app\nstack: [\nproof:\n  start: npm run dev\n",
    );
    const records = await readRecords(repo, []);
    expect(records.profileError).toMatch(/^profile\.yml can't be read: /);
    expect(records.proof).toBeNull();
  });
});

describe("ProjectChecks.forget during a check", () => {
  it("doesn't hold a check that lands after its repo was forgotten", async () => {
    let clock = 0;
    let land: (check: ProjectCheck) => void = () => undefined;
    const check = vi.fn(
      (repoPath: string) =>
        new Promise<ProjectCheck>((resolve) => {
          land = resolve;
          void repoPath;
        }),
    );
    const checks = new ProjectChecks({
      check,
      records: async () => ({
        openTask: null,
        profileError: null,
        autonomy: { configured: null, entries: [], problems: [] },
        proof: null,
        skills: {
          locked: [],
          installed: 0,
          syncedAt: null,
          problems: [],
          gaps: [],
          error: null,
        },
        banned: { patterns: [], error: null },
      }),
      views: () => [],
      onUpdate: vi.fn(),
      onError: vi.fn(),
      now: () => clock,
    });
    checks.recheck("/repo");
    checks.forget("/repo");
    land({
      repoPath: "/repo",
      checkedAt: "2026-11-24T09:00:00.000Z",
      profileFound: true,
      fields: [],
      otherFlags: [],
      problems: [],
    });
    // Let the landed check settle before a day passes.
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock += CHECK_EVERY_MS;
    checks.due();
    expect(check).toHaveBeenCalledTimes(1);
  });
});
