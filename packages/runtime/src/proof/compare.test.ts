// The UI proof's comparisons, without a browser: which changes can render,
// which axe violations the base already had, which image pairs didn't change,
// and which ready selector a page gets.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareViolations,
  identicalPairs,
  uiFiles,
  violationCount,
  violationList,
} from "./compare.js";
import { isContainerFile } from "./docker.js";
import { readySelectorFor } from "./ready.js";
import { breakpointFor, DEFAULT_WIDTHS } from "./shoot.js";

const made: string[] = [];
afterEach(async () => {
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

describe("uiFiles", () => {
  it("finds nothing that renders in a docs, tests or tooling change", () => {
    expect(
      uiFiles([
        "README.md",
        "PLAN.md",
        "docs/deploy/PLAN.md",
        "packages/api/README.md",
        "src/total.test.ts",
        ".github/workflows/ci.yml",
        ".changeset/x.md",
        "Dockerfile",
        "LICENSE",
      ]),
    ).toEqual([]);
  });

  it("counts source, styles, markup and anything unfamiliar as UI", () => {
    const paths = [
      "src/app/page.tsx",
      "src/styles.css",
      "public/index.html",
      "server.js",
      "package.json",
      "content/post.mdx",
      "content/posts/hello.md",
    ];
    expect(uiFiles([...paths, "README.md"])).toEqual(paths);
  });
});

describe("axe comparison", () => {
  const v = (id: string, breakpoint: string, nodes = 1) => ({
    id,
    impact: "serious",
    page: "/",
    nodes,
    breakpoint,
  });

  it("calls a violation the base had at the same width pre-existing, and one it didn't new", () => {
    const { added, preExisting } = compareViolations(
      [v("color-contrast", "sm"), v("image-alt", "lg", 2)],
      [
        v("color-contrast", "sm"),
        v("color-contrast", "lg"),
        v("image-alt", "lg", 3),
      ],
    );
    expect(preExisting).toEqual([v("color-contrast", "sm")]);
    // At a width the base didn't have it, or on more nodes, it's the change's.
    expect(added).toEqual([v("color-contrast", "lg"), v("image-alt", "lg", 3)]);
  });

  it("lists a violation once per rule and page, with every width it showed at", () => {
    const found = [
      v("image-alt", "sm"),
      v("image-alt", "lg", 2),
      v("label", "sm"),
    ];
    expect(violationCount(found)).toBe(2);
    expect(violationList(found)).toBe(
      "image-alt on / (serious, 2) at sm/lg; label on / (serious, 1) at sm",
    );
  });
});

describe("identicalPairs", () => {
  it("names the pairs whose rendered images are byte for byte the same", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rivetari-identical-"));
    made.push(dir);
    const file = async (name: string, text: string) => {
      const path = join(dir, name);
      await writeFile(path, text);
      return path;
    };
    const shot = (
      side: "before" | "after",
      breakpoint: string,
      path: string,
      ready = true,
    ) => ({
      side,
      page: "/",
      breakpoint,
      file: path,
      status: 200,
      ready,
      bytes: 4,
    });
    const shots = [
      shot("before", "sm", await file("b-sm", "same")),
      shot("after", "sm", await file("a-sm", "same")),
      shot("before", "md", await file("b-md", "aaaa")),
      shot("after", "md", await file("a-md", "bbbb")),
      // A pair where either side never rendered says nothing about the change.
      shot("before", "lg", await file("b-lg", "skel"), false),
      shot("after", "lg", await file("a-lg", "skel")),
    ];
    expect(await identicalPairs(shots)).toEqual([
      { page: "/", breakpoint: "sm" },
    ]);
  });
});

describe("readySelectorFor", () => {
  const config = {
    "/cloud/trends": "#chart",
    "/cloud/sessions/*": "text=Session summary",
    "/settings?tab=b": "#b",
    "*": "main h1",
  };

  it("takes an exact path first, then a glob, then *", () => {
    expect(readySelectorFor("/cloud/trends/", config)).toBe("#chart");
    expect(readySelectorFor("/cloud/trends?range=13w", config)).toBe("#chart");
    expect(readySelectorFor("/cloud/sessions/42", config)).toBe(
      "text=Session summary",
    );
    expect(readySelectorFor("/settings?tab=b", config)).toBe("#b");
    expect(readySelectorFor("/settings?tab=a", config)).toBe("main h1");
  });

  it("applies one string to every page, and nothing when unset", () => {
    expect(readySelectorFor("/anything", "#app[data-ready]")).toBe(
      "#app[data-ready]",
    );
    expect(readySelectorFor("/", undefined)).toBeUndefined();
    expect(readySelectorFor("/x", { "/y": "#y" })).toBeUndefined();
  });
});

describe("breakpoints and container files", () => {
  it("keeps sm, md and lg for the default widths and names others by width", () => {
    expect(DEFAULT_WIDTHS).toEqual([375, 768, 1280]);
    expect(breakpointFor(768).name).toBe("md");
    expect(breakpointFor(1024)).toEqual({
      name: "w1024",
      width: 1024,
      height: 800,
    });
    expect(breakpointFor(414).height).toBe(812);
  });

  it("knows a container change when it sees one", () => {
    for (const p of [
      "Dockerfile",
      "api/Dockerfile.prod",
      "web.dockerfile",
      "docker-compose.yml",
      "compose.yaml",
    ])
      expect(isContainerFile(p)).toBe(true);
    for (const p of ["src/docker.ts", "README.md", "Dockerfiles/notes.txt"])
      expect(isContainerFile(p)).toBe(false);
  });
});
