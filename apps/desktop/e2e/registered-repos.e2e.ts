import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import {
  closeApp,
  copyFixtureRepo,
  launchApp,
  type LaunchedApp,
} from "./helpers";

// main decides which repo a request is about from its own registered list.
// A renderer that sends another folder's path, as a compromised one could,
// is refused before anything there is read or written; the registered repo
// still answers as before.

/** The part of the bridge these requests use, as the renderer sees it. */
interface Bridge {
  docs: {
    list(repoPath: string): Promise<unknown[]>;
    read(repoPath: string, path: string): Promise<{ markdown: string }>;
  };
  profile: {
    load(repoPath: string): Promise<unknown>;
    save(repoPath: string, profile: unknown): Promise<unknown>;
  };
}

test.describe("registered repos", () => {
  let launched: LaunchedApp | undefined;
  const cleanup: string[] = [];

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
    launched = undefined;
    for (const dir of cleanup.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  test("main refuses a repo path that isn't registered", async () => {
    const repo = copyFixtureRepo();
    const other = mkdtempSync(join(tmpdir(), "rivetari-e2e-unregistered-"));
    const config = mkdtempSync(join(tmpdir(), "rivetari-e2e-config-"));
    cleanup.push(repo, other, config);
    writeFileSync(join(other, "secret.md"), "# not for the app\n");
    launched = await launchApp({
      repos: [{ path: repo, name: "sample-repo" }],
      env: { RIVETARI_CONFIG_DIR: config },
    });
    const { page } = launched;

    // The registered repo answers.
    const listed = await page.evaluate(
      (repoPath) =>
        (window as unknown as { rivetari: Bridge }).rivetari.docs
          .list(repoPath)
          .then((docs) => docs.length),
      repo,
    );
    expect(listed).toBeGreaterThanOrEqual(0);
    const profile = await page.evaluate(
      (repoPath) =>
        (window as unknown as { rivetari: Bridge }).rivetari.profile.load(
          repoPath,
        ),
      repo,
    );
    expect(profile).not.toBeNull();

    // Another folder is refused, for a read and for a write.
    const read = await page.evaluate(
      (repoPath) =>
        (window as unknown as { rivetari: Bridge }).rivetari.docs
          .read(repoPath, "secret.md")
          .then(
            (doc) => `read: ${doc.markdown}`,
            (err: unknown) => `refused: ${String(err)}`,
          ),
      other,
    );
    expect(read).toContain("refused");
    expect(read).toContain("isn't one of the registered repos");

    const saved = await page.evaluate(
      ([repoPath, p]) =>
        (window as unknown as { rivetari: Bridge }).rivetari.profile
          .save(repoPath, p)
          .then(
            () => "saved",
            (err: unknown) => `refused: ${String(err)}`,
          ),
      [other, profile] as const,
    );
    expect(saved).toContain("isn't one of the registered repos");
    expect(existsSync(join(other, ".rivetari", "profile.yml"))).toBe(false);

    // A path that climbs out of the registered repo isn't that repo either.
    const climbed = await page.evaluate(
      (repoPath) =>
        (window as unknown as { rivetari: Bridge }).rivetari.docs
          .read(repoPath, "secret.md")
          .then(
            () => "read",
            (err: unknown) => `refused: ${String(err)}`,
          ),
      join(repo, "..", other.split(/[\\/]/).pop()!),
    );
    expect(climbed).toContain("isn't one of the registered repos");
  });
});
