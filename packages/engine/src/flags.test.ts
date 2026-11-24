import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildContext } from "./context.js";
import { inferFlags } from "./flags.js";

// Only the flags a file can show are inferred, each with what shows it, so the
// desktop's Project view can suggest adding one and say why.

describe("inferFlags", () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const d of made.splice(0))
      await rm(d, { recursive: true, force: true });
  });
  const flagsOf = async (files: Record<string, string>) => {
    const d = await mkdtemp(join(tmpdir(), "engine-flags-"));
    made.push(d);
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(dirname(join(d, rel)), { recursive: true });
      await writeFile(join(d, rel), text);
    }
    return inferFlags(buildContext(d));
  };
  const pkg = (p: object) => JSON.stringify(p);

  it("finds nothing in an empty repo", async () => {
    expect(await flagsOf({})).toEqual([]);
  });

  it("reads an open-source license from LICENSE", async () => {
    expect(
      await flagsOf({
        LICENSE:
          "MIT License\n\nCopyright (c) 2026 Someone\n\nPermission is hereby granted, free of charge, …",
      }),
    ).toEqual([
      { flag: "open-source", evidence: "LICENSE is the MIT License" },
    ]);
    expect(
      await flagsOf({
        "LICENSE.md":
          "Copyright (c) 2026\n\nRedistribution and use in source and binary forms, with or without modification, …",
      }),
    ).toEqual([
      { flag: "open-source", evidence: "LICENSE.md is a BSD license" },
    ]);
  });

  it("takes package.json's license only for a package that isn't private", async () => {
    expect(
      await flagsOf({ "package.json": pkg({ license: "Apache-2.0" }) }),
    ).toEqual([
      { flag: "open-source", evidence: "package.json's license is Apache-2.0" },
    ]);
    expect(
      await flagsOf({ "package.json": pkg({ license: "MIT", private: true }) }),
    ).toEqual([]);
    expect(
      await flagsOf({ "package.json": pkg({ license: "UNLICENSED" }) }),
    ).toEqual([]);
  });

  it("doesn't count a proprietary LICENSE", async () => {
    expect(
      await flagsOf({
        LICENSE: "Copyright (c) 2026 Acme. All rights reserved.\n",
      }),
    ).toEqual([]);
  });

  it("reads uses-ai from a runtime dependency on an AI SDK, in any package", async () => {
    expect(
      await flagsOf({
        "package.json": pkg({ private: true }),
        "packages/engine/package.json": pkg({
          dependencies: { "@anthropic-ai/sdk": "1" },
        }),
      }),
    ).toEqual([
      {
        flag: "uses-ai",
        evidence: "packages/engine/package.json depends on @anthropic-ai/sdk",
      },
    ]);
    expect(
      await flagsOf({
        "package.json": pkg({ dependencies: { "@ai-sdk/openai": "1" } }),
      }),
    ).toEqual([
      { flag: "uses-ai", evidence: "package.json depends on @ai-sdk/openai" },
    ]);
    expect(
      await flagsOf({ "requirements.txt": "anthropic>=0.40\nrequests\n" }),
    ).toEqual([
      { flag: "uses-ai", evidence: "requirements.txt names anthropic" },
    ]);
  });

  it("doesn't take a dev dependency, or a name that only contains one, as using AI", async () => {
    expect(
      await flagsOf({
        "package.json": pkg({ devDependencies: { openai: "4" } }),
      }),
    ).toEqual([]);
    expect(
      await flagsOf({
        "package.json": pkg({ dependencies: { "openai-mock": "1" } }),
      }),
    ).toEqual([]);
    expect(await flagsOf({ "requirements.txt": "anthropic-utils\n" })).toEqual(
      [],
    );
  });

  it("reads distributes-binaries from a packager's config or dependency", async () => {
    expect(
      await flagsOf({ "apps/desktop/electron-builder.yml": "appId: x\n" }),
    ).toEqual([
      {
        flag: "distributes-binaries",
        evidence: "apps/desktop/electron-builder.yml packages binaries",
      },
    ]);
    expect(await flagsOf({ ".goreleaser.yaml": "builds: []\n" })).toEqual([
      {
        flag: "distributes-binaries",
        evidence: ".goreleaser.yaml packages binaries",
      },
    ]);
    expect(
      await flagsOf({
        "package.json": pkg({
          devDependencies: { "@electron-forge/cli": "7" },
        }),
      }),
    ).toEqual([
      {
        flag: "distributes-binaries",
        evidence: "package.json builds with @electron-forge/cli",
      },
    ]);
  });

  it("lists what it finds in the catalog's flag order", async () => {
    const found = await flagsOf({
      LICENSE: "Apache License\nVersion 2.0, January 2004\n",
      "package.json": pkg({
        dependencies: { openai: "4" },
        devDependencies: { "electron-builder": "26" },
      }),
    });
    expect(found.map((f) => f.flag)).toEqual([
      "uses-ai",
      "open-source",
      "distributes-binaries",
    ]);
  });
});
