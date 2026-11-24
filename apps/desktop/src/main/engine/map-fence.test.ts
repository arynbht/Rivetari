import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { attachMapWebview, mapRequestAllowed, realPath } from "./map";
import { MAP_PARTITION } from "../../shared/ipc";

// The map's fence goes by real paths: a link or junction inside floorplan/
// that points elsewhere, or a floorplan/ that is itself one, can't take the
// map's session outside the folder, though every name on the way looks inside.

let root = "";
let repo = "";
let mapDir = "";
let outside = "";

const url = (...parts: string[]) => pathToFileURL(join(...parts)).href;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "rivetari-desktop-fence-"));
  repo = join(root, "repo");
  mapDir = join(repo, "floorplan");
  outside = join(root, "outside");
  mkdirSync(join(mapDir, "assets"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(mapDir, "index.html"), "<p>map</p>");
  writeFileSync(join(mapDir, "assets", "map.js"), "");
  writeFileSync(join(outside, "secret.txt"), "not the map's");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("the map fence", () => {
  it("still lets the map's own files through, and ones not written yet", () => {
    expect(mapRequestAllowed(url(mapDir, "index.html"), mapDir)).toBe(true);
    expect(mapRequestAllowed(url(mapDir, "assets", "map.js"), mapDir)).toBe(
      true,
    );
    expect(mapRequestAllowed(url(mapDir, "favicon.ico"), mapDir)).toBe(true);
  });

  it("refuses a file reached through a link or junction inside floorplan/", () => {
    // A junction needs no privilege on Windows; elsewhere it's a plain link.
    symlinkSync(outside, join(mapDir, "escape"), "junction");
    const escaped = url(mapDir, "escape", "secret.txt");
    expect(mapRequestAllowed(escaped, mapDir)).toBe(false);
    expect(
      mapRequestAllowed(url(mapDir, "escape", "missing.txt"), mapDir),
    ).toBe(false);
    expect(
      attachMapWebview(
        {
          params: { src: escaped, partition: MAP_PARTITION },
          webPreferences: {},
        },
        mapDir,
      ),
    ).toBe(false);
  });

  it("refuses everything when floorplan/ is itself a link elsewhere", () => {
    rmSync(mapDir, { recursive: true, force: true });
    symlinkSync(outside, mapDir, "junction");
    expect(mapRequestAllowed(url(mapDir, "secret.txt"), mapDir)).toBe(false);
  });

  it("follows links above the repo, as a linked temp or projects folder is", () => {
    const linked = join(root, "linked");
    symlinkSync(root, linked, "junction");
    const viaLink = join(linked, "repo", "floorplan");
    expect(mapRequestAllowed(url(viaLink, "index.html"), viaLink)).toBe(true);
  });

  it("reads a real path through links, keeping a missing tail", () => {
    symlinkSync(outside, join(mapDir, "escape"), "junction");
    expect(realPath(join(mapDir, "escape", "secret.txt"))).toBe(
      realPath(join(outside, "secret.txt")),
    );
    expect(realPath(join(mapDir, "escape", "nope", "x.txt"))).toBe(
      join(realPath(outside)!, "nope", "x.txt"),
    );
  });
});
