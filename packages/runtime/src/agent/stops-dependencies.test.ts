// A new dependency is its own stop, asked whatever the autonomy level, naming
// each package and version (the pilot's R-29: T-0028's @playwright/test was
// only flagged, and reached a person through the package.json scripts stop).
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { simpleGit } from "simple-git";
import { afterEach, describe, expect, it } from "vitest";

import { isSoftStop } from "../task/autonomy.js";
import { findStops, withLicenses } from "./stops.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

const assembly = { stop_and_ask: ["new_dependency"] } as unknown as Parameters<
  typeof findStops
>[3];

async function change(
  base: Record<string, string>,
  edits: Record<string, string>,
): Promise<{ dir: string; from: string; to: string }> {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-deps-"));
  made.push(dir);
  const git = simpleGit(dir);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  const write = async (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    }
    await git.add(["-A"]);
    await git.commit("c", ["--no-verify"]);
    return (await git.revparse(["HEAD"])).trim();
  };
  const from = await write(base);
  const to = await write(edits);
  return { dir, from, to };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

// breathband-console's package.json before T-0028, cut down.
const CONSOLE = {
  name: "breathband-console",
  scripts: { dev: "next dev", test: "vitest run" },
  dependencies: { next: "15.5.0", react: "19.1.0" },
  devDependencies: { vitest: "^3.2.4" },
};

describe("the new-dependency stop", () => {
  it("names T-0028's @playwright/test and its version, apart from the scripts stop, and is never soft", async () => {
    const { dir, from, to } = await change(
      { "package.json": json(CONSOLE) },
      {
        "package.json": json({
          ...CONSOLE,
          scripts: { ...CONSOLE.scripts, "test:e2e": "playwright test" },
          devDependencies: {
            ...CONSOLE.devDependencies,
            "@playwright/test": "1.65.1",
          },
        }),
      },
    );
    const stops = await findStops(dir, from, to, assembly);
    const dep = stops.find((s) => s.trigger === "new_dependency");
    expect(dep).toMatchObject({
      detail: "package.json adds @playwright/test@1.65.1",
      manifest: "package.json",
      packages: ["@playwright/test"],
    });
    expect(stops.map((s) => s.trigger)).toContain("protected_path");
    // Its license on the OSI list no longer lets autonomy flag it.
    await mkdir(join(dir, "node_modules", "@playwright", "test"), {
      recursive: true,
    });
    await writeFile(
      join(dir, "node_modules", "@playwright", "test", "package.json"),
      json({ name: "@playwright/test", license: "Apache-2.0" }),
    );
    const licensed = await withLicenses(dir, dep!);
    expect(licensed.osi).toBe(true);
    expect(isSoftStop(licensed)).toBe(false);
  });

  it("names a dependency only a lockfile adds, and not one its package.json already names", async () => {
    const lock = (deps: Record<string, string>) =>
      `lockfileVersion: '9.0'\n\nimporters:\n\n  .:\n    dependencies:\n${Object.entries(
        deps,
      )
        .map(
          ([n, v]) =>
            `      ${n}:\n        specifier: ^${v}\n        version: ${v}(react@19.1.0)\n`,
        )
        .join("")}`;
    const { dir, from, to } = await change(
      {
        "package.json": json({ name: "x", dependencies: { react: "19.1.0" } }),
        "pnpm-lock.yaml": lock({ react: "19.1.0" }),
      },
      {
        "package.json": json({
          name: "x",
          dependencies: { react: "19.1.0", zod: "^4.0.0" },
        }),
        "pnpm-lock.yaml": lock({
          react: "19.1.0",
          zod: "4.0.0",
          "left-pad": "1.3.0",
        }),
      },
    );
    const stops = await findStops(dir, from, to, assembly);
    expect(stops.map((s) => s.detail)).toEqual([
      "package.json adds zod@^4.0.0",
      "pnpm-lock.yaml adds left-pad@1.3.0, which no package.json declares",
    ]);
  });

  it("reads npm's lockfile for its installed version", async () => {
    const lock = (deps: Record<string, string>) =>
      json({
        name: "x",
        lockfileVersion: 3,
        packages: {
          "": { name: "x", dependencies: deps },
          ...Object.fromEntries(
            Object.keys(deps).map((n) => [
              `node_modules/${n}`,
              { version: "1.3.0" },
            ]),
          ),
        },
      });
    const { dir, from, to } = await change(
      { "package.json": json({ name: "x" }), "package-lock.json": lock({}) },
      { "package-lock.json": lock({ "left-pad": "^1.3.0" }) },
    );
    expect(
      (await findStops(dir, from, to, assembly)).map((s) => s.detail),
    ).toEqual([
      "package-lock.json adds left-pad@1.3.0, which no package.json declares",
    ]);
  });

  it("names what requirements.txt, go.mod and Cargo.toml add", async () => {
    const { dir, from, to } = await change(
      {
        "requirements.txt": "flask==3.0.0\n",
        "go.mod":
          "module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.0.0\n)\n",
        "Cargo.toml":
          '[package]\nname = "x"\n\n[dependencies]\nserde = "1.0"\n',
      },
      {
        "requirements.txt": "flask==3.0.0\nrequests>=2.32 # http\n-r dev.txt\n",
        "go.mod":
          "module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/a/b v1.0.0\n\tgithub.com/c/d v0.2.1 // indirect\n)\n\nrequire golang.org/x/text v0.14.0\n",
        "Cargo.toml":
          '[package]\nname = "x"\n\n[dependencies]\nserde = "1.0"\ntokio = { version = "1.38", features = ["full"] }\n\n[dev-dependencies.insta]\nversion = "1.39"\n',
      },
    );
    expect(
      (await findStops(dir, from, to, assembly)).map((s) => s.detail),
    ).toEqual([
      "Cargo.toml adds insta@1.39, tokio@1.38",
      "go.mod adds github.com/c/d@v0.2.1 (indirect), golang.org/x/text@v0.14.0",
      "requirements.txt adds requests@>=2.32",
    ]);
  });

  it("still stops on a manifest it can't read the packages of", async () => {
    const { dir, from, to } = await change(
      { Gemfile: 'gem "rails"\n' },
      { Gemfile: 'gem "rails"\ngem "pry"\n' },
    );
    expect(await findStops(dir, from, to, assembly)).toEqual([
      { trigger: "new_dependency", detail: "Gemfile changed" },
    ]);
  });
});
