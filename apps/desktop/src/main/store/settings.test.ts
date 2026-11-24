import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The store reads userData from electron's app; point it at a temp dir.
const userData = { dir: "" };
vi.mock("electron", () => ({
  app: { getPath: () => userData.dir },
}));

const { loadSettings, saveSettings } = await import("./settings");

describe("settings store", () => {
  beforeEach(async () => {
    userData.dir = await mkdtemp(join(tmpdir(), "rivetari-settings-"));
  });

  afterEach(async () => {
    await rm(userData.dir, { recursive: true, force: true });
  });

  it("loads a file saved before defaultOrg was removed", async () => {
    await writeFile(
      join(userData.dir, "settings.json"),
      JSON.stringify({
        theme: "light",
        defaultOrg: "my-org",
        aiPreferApiKey: true,
        autoCheckUpdates: false,
      }),
    );
    const settings = await loadSettings();
    expect(settings).toEqual({
      theme: "light",
      aiPreferApiKey: true,
      autoCheckUpdates: false,
    });
  });

  it("drops defaultOrg from the file on the next save", async () => {
    const file = join(userData.dir, "settings.json");
    await writeFile(
      file,
      JSON.stringify({ theme: "dark", defaultOrg: "my-org" }),
    );
    await saveSettings({ theme: "system" });
    const saved = JSON.parse(await readFile(file, "utf8")) as Record<
      string,
      unknown
    >;
    expect(saved).not.toHaveProperty("defaultOrg");
    expect(saved.theme).toBe("system");
  });
});
