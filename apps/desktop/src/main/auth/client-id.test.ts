import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  appClientId,
  notConfiguredMessage,
  resolveClientId,
} from "./client-id";

let config = "";
const savedConfig = process.env.RIVETARI_CONFIG_DIR;

beforeEach(async () => {
  config = await mkdtemp(join(tmpdir(), "rivetari-desktop-client-id-"));
  process.env.RIVETARI_CONFIG_DIR = config;
});

afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  await rm(config, { recursive: true, force: true });
});

const writeApp = (record: unknown) =>
  writeFile(join(config, "app.json"), JSON.stringify(record));

describe("the GitHub client id sign-in uses", () => {
  it("takes the env var first, then the App `rivetari app register` recorded, else none", async () => {
    await writeApp({
      id: 1,
      slug: "rivetari-ab",
      clientId: "Iv23liFromApp",
      owner: "ab",
      htmlUrl: "https://github.com/apps/rivetari-ab",
    });
    expect(
      await resolveClientId({ RIVETARI_GITHUB_CLIENT_ID: " Iv1.fromEnv " }),
    ).toEqual({ clientId: "Iv1.fromEnv", source: "env" });
    // A blank env var doesn't count.
    expect(await resolveClientId({ RIVETARI_GITHUB_CLIENT_ID: "  " })).toEqual({
      clientId: "Iv23liFromApp",
      source: "app",
    });
    expect(await resolveClientId({})).toEqual({
      clientId: "Iv23liFromApp",
      source: "app",
    });

    await rm(join(config, "app.json"));
    expect(await resolveClientId({})).toBeNull();
  });

  it("reads no client id from an app.json that's broken or lacks one", async () => {
    await writeFile(join(config, "app.json"), "{ not json");
    expect(await appClientId()).toBeNull();
    await writeApp({ id: 1, slug: "x", clientId: "" });
    expect(await appClientId()).toBeNull();
    await writeApp({ id: 1, slug: "x", clientId: 42 });
    expect(await appClientId()).toBeNull();
  });

  it("names both places it looked when neither has one", () => {
    const message = notConfiguredMessage();
    expect(message).toMatch(/isn't configured/);
    expect(message).toContain("RIVETARI_GITHUB_CLIENT_ID");
    expect(message).toContain(join(config, "app.json"));
    expect(message).toContain("rivetari app register");
  });
});
