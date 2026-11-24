import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildContext } from "./context.js";
import { loadProfile, ProfileError } from "./profile.js";

const VALID = `version: 1
name: sample
type: web-app
stack: [typescript, react]
phase: build
flags:
  public-facing: true
severity-floor: medium
`;

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repoWith(profile: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-profile-keys-"));
  made.push(dir);
  await mkdir(join(dir, ".rivetari"));
  await writeFile(join(dir, ".rivetari", "profile.yml"), profile);
  return dir;
}

// What a newer CLI writes: a top-level key and a nested one this version
// doesn't know (the pilot's audit-pr failed on exactly these, R-8).
const NEWER = `${VALID}floorplan: true
someday:
  thing: 1
`;

describe("loadProfile with keys it doesn't know", () => {
  it("fails by default, so a person's typo is caught", async () => {
    await expect(loadProfile(await repoWith(NEWER))).rejects.toBeInstanceOf(
      ProfileError,
    );
  });

  it("warns, names the keys and loads the rest when asked to", async () => {
    const warnings: string[] = [];
    const profile = await loadProfile(await repoWith(NEWER), {
      unknownKeys: "warn",
      onWarning: (m) => warnings.push(m),
    });
    expect(profile?.name).toBe("sample");
    expect(profile?.["severity-floor"]).toBe("medium");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("someday");
    expect(warnings[0]).not.toContain("floorplan:");
  });

  it("names a key nested inside a known block by its path", async () => {
    const warnings: string[] = [];
    await loadProfile(
      await repoWith(`${VALID}proof:\n  start: npm run dev\n  newer_key: 1\n`),
      { unknownKeys: "warn", onWarning: (m) => warnings.push(m) },
    );
    expect(warnings[0]).toContain("proof.newer_key");
  });

  it("still fails in warn mode when anything else is wrong", async () => {
    const broken = NEWER.replace(
      "severity-floor: medium",
      "severity-floor: huge",
    );
    await expect(
      loadProfile(await repoWith(broken), {
        unknownKeys: "warn",
        onWarning: () => undefined,
      }),
    ).rejects.toBeInstanceOf(ProfileError);
  });

  it("says nothing for a profile it fully knows", async () => {
    const warnings: string[] = [];
    await loadProfile(await repoWith(VALID), {
      unknownKeys: "warn",
      onWarning: (m) => warnings.push(m),
    });
    expect(warnings).toEqual([]);
  });

  it("passes the mode through buildContext, the way rivetari ci asks for it", async () => {
    const warnings: string[] = [];
    const ctx = buildContext(await repoWith(NEWER), {
      profileUnknownKeys: "warn",
      onProfileWarning: (m) => warnings.push(m),
    });
    expect((await ctx.profile())?.name).toBe("sample");
    expect(warnings[0]).toContain("someday");
    await expect(
      buildContext(await repoWith(NEWER)).profile(),
    ).rejects.toBeInstanceOf(ProfileError);
  });
});
