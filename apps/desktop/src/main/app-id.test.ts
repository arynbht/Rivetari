import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { APP_ID, appIdOf } from "./app-id";

// Windows shows the app's notifications under the id the installer
// registered, so the app reads it from the installer's own config.

describe("the app's id", () => {
  it("is electron-builder.yml's appId", () => {
    const config = readFileSync(
      join(import.meta.dirname, "..", "..", "electron-builder.yml"),
      "utf8",
    );
    expect(APP_ID).toBe(/^appId: (\S+)$/m.exec(config)?.[1]);
    expect(APP_ID).toBe("io.github.arynbht.rivetari");
  });

  it("reads a quoted or commented appId, and refuses a config with none", () => {
    expect(appIdOf('# x\nappId: "com.example.app" # the id\n')).toBe(
      "com.example.app",
    );
    expect(() => appIdOf("productName: X\n  appId: nested\n")).toThrow(
      "electron-builder.yml has no top-level appId",
    );
  });
});
