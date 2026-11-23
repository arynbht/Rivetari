import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  attachMapWebview,
  getMap,
  guardMapSession,
  keepBlocked,
  MAP_PARTITION,
  type MapSession,
  mapRequestAllowed,
  type WebviewAttach,
} from "./map";

let repo = "";
let dir = "";
const file = (...parts: string[]) => pathToFileURL(join(...parts)).href;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "rivetari-desktop-map-"));
  dir = join(repo, "floorplan");
});

afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe("what the map's session may load", () => {
  it("allows only files inside the repo's floorplan/", () => {
    expect(mapRequestAllowed(file(dir, "index.html"), dir)).toBe(true);
    expect(
      mapRequestAllowed(file(dir, "descriptions", "a.json") + "?v=1#x", dir),
    ).toBe(true);

    for (const url of [
      file(repo, "README.md"),
      file(repo, "floorplan-evil", "index.html"),
      file(dir),
      `${pathToFileURL(dir).href}/../.env`,
      `${pathToFileURL(dir).href}/%2e%2e/.env`,
      "file://server/share/floorplan/index.html",
      "https://floorplan-waitlist.example.com/",
      "http://localhost:4173/api/cloud/join",
      "ws://127.0.0.1:9/",
      "data:text/html,<p>hi</p>",
      "vscode://file/etc/passwd",
      "not a url",
    ])
      expect(mapRequestAllowed(url, dir), url).toBe(false);
    // No map on show: nothing loads.
    expect(mapRequestAllowed(file(dir, "index.html"), null)).toBe(false);
  });
});

describe("the repo's map", () => {
  it("is none until floorplan/ holds a drawn map with its page, and says whether the profile has it on", async () => {
    expect(await getMap(repo)).toEqual({
      repoPath: repo,
      dir,
      url: null,
      floorplanOn: false,
    });

    // A project folder that happens to be called floorplan/ isn't a map.
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "index.html"), "<h1>ours</h1>");
    expect((await getMap(repo)).url).toBeNull();

    await writeFile(join(dir, "architecture.json"), "{}");
    await mkdir(join(repo, ".rivetari"), { recursive: true });
    await writeFile(
      join(repo, ".rivetari", "profile.yml"),
      "version: 1\nname: x\ntype: cli\nfloorplan: true\n",
    );
    const view = await getMap(repo);
    expect(view.url).toBe(file(dir, "index.html"));
    expect(view.floorplanOn).toBe(true);
  });
});

describe("the map's session guard", () => {
  function fakeSession() {
    const fake = {
      before: undefined as
        | ((d: { url: string }, cb: (r: { cancel: boolean }) => void) => void)
        | undefined,
      request: undefined as
        | ((wc: unknown, p: string, cb: (g: boolean) => void) => void)
        | undefined,
      check: undefined as (() => boolean) | undefined,
    };
    const session: MapSession = {
      webRequest: { onBeforeRequest: (l) => (fake.before = l) },
      setPermissionRequestHandler: (h) => (fake.request = h),
      setPermissionCheckHandler: (h) => (fake.check = h),
    };
    return { fake, session };
  }

  it("cancels and reports everything outside the current map, and refuses every permission", () => {
    const { fake, session } = fakeSession();
    let current: string | null = dir;
    const blocked: string[] = [];
    guardMapSession(
      session,
      () => current,
      (url) => blocked.push(url),
    );
    const decide = (url: string) => {
      let cancel: boolean | undefined;
      fake.before?.({ url }, (r) => (cancel = r.cancel));
      return cancel;
    };

    expect(decide(file(dir, "index.html"))).toBe(false);
    expect(decide("https://floorplan-waitlist.example.com/")).toBe(true);
    expect(decide(file(repo, ".env"))).toBe(true);
    expect(blocked).toEqual([
      "https://floorplan-waitlist.example.com/",
      file(repo, ".env"),
    ]);

    // Another repo selected: the fence moves with it.
    current = join(repo, "other", "floorplan");
    expect(decide(file(dir, "index.html"))).toBe(true);

    let granted: boolean | undefined;
    fake.request?.(null, "notifications", (g) => (granted = g));
    expect(granted).toBe(false);
    expect(fake.check?.()).toBe(false);
  });

  it("keeps the last fifty blocked requests", () => {
    let list: string[] = [];
    for (let i = 0; i < 60; i++) list = keepBlocked(list, `https://x/${i}`);
    expect(list).toHaveLength(50);
    expect(list[0]).toBe("https://x/10");
    expect(list.at(-1)).toBe("https://x/59");
  });
});

describe("which webview may attach", () => {
  const attach = (params: WebviewAttach["params"]): WebviewAttach => ({
    params,
    webPreferences: {
      preload: "/evil/preload.js",
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      contextIsolation: false,
      sandbox: false,
      webSecurity: false,
      allowRunningInsecureContent: true,
    },
  });

  it("is only the map's, on its session, loading the map, and it's locked down", () => {
    const ok = attach({
      src: file(dir, "index.html"),
      partition: MAP_PARTITION,
    });
    expect(attachMapWebview(ok, dir)).toBe(true);
    expect(ok.webPreferences).toEqual({
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });

    expect(
      attachMapWebview(attach({ src: file(dir, "index.html") }), dir),
    ).toBe(false);
    expect(
      attachMapWebview(
        attach({ src: "https://example.com/", partition: MAP_PARTITION }),
        dir,
      ),
    ).toBe(false);
    expect(
      attachMapWebview(
        attach({ src: file(repo, "README.md"), partition: MAP_PARTITION }),
        dir,
      ),
    ).toBe(false);
    expect(
      attachMapWebview(
        attach({ src: file(dir, "index.html"), partition: MAP_PARTITION }),
        null,
      ),
    ).toBe(false);
  });
});
