// Map adapter: the floorplan skill's static map of the repo (floorplan/index.html,
// drawn at init and on a merged close when the profile has `floorplan: true`),
// shown in a <webview> on its own session. The map's server (serve.mjs) is the
// only part of floorplan that reaches the network and is never started; the page
// itself still has buttons that would ("Notify me" posts to the waitlist), so
// the map's session cancels every request that isn't a file inside that repo's
// floorplan/. The fence goes by real paths, so a link or junction can't lead
// out of the folder while every name on the way looks inside it.
// Electron-free: the session and webview hooks take what they use.
import { realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadProfile } from "@arynbht/rivetari-engine";
import { FLOORPLAN_DIR, isFloorplanMap } from "@arynbht/rivetari-runtime";

import { MAP_PARTITION, type MapView } from "../../shared/ipc";

// The map's session (in memory only, shared by nothing else in the app) is named in
// the IPC contract so the renderer's webview names the same one.
export { MAP_PARTITION };
/** How many blocked requests are kept to show; a chatty page can't grow it without end. */
const BLOCKED_KEPT = 50;

/** True when `path` is below `dir`, by the names alone. */
const below = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** The same place by the names alone (case-insensitive where the OS is). */
const same = (a: string, b: string) => relative(a, b) === "";

/**
 * The real path of `path`, links and junctions followed. A path that doesn't
 * exist keeps its missing tail on the real path of what does, since a missing
 * name can't be a link. Null when nothing along it can be read.
 */
export function realPath(path: string): string | null {
  const missing: string[] = [];
  let at = path;
  for (;;) {
    try {
      return join(realpathSync.native(at), ...missing);
    } catch {
      const up = dirname(at);
      if (up === at) return null;
      missing.unshift(basename(at));
      at = up;
    }
  }
}

/**
 * True only for a file:// URL naming a file inside `mapDir`: no other scheme
 * (http, https, ws, data, a custom one), no file on another host (a UNC share)
 * and no path that leaves the directory, by its names or by where its links
 * lead. A floorplan/ that is itself a link isn't the repo's own, so nothing
 * through it is let through; links above the repo (a linked projects or temp
 * folder) are followed like any other part of the path.
 */
export function mapRequestAllowed(url: string, mapDir: string | null): boolean {
  if (!mapDir) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "file:" || parsed.host !== "") return false;
  let path: string;
  try {
    path = fileURLToPath(parsed);
  } catch {
    return false;
  }
  if (!below(mapDir, path)) return false;
  const realDir = realPath(mapDir);
  const realParent = realPath(dirname(mapDir));
  const real = realPath(path);
  if (!realDir || !realParent || !real) return false;
  if (!same(realDir, join(realParent, basename(mapDir)))) return false;
  return below(realDir, real);
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

/** The repo's map, or why there isn't one. */
export async function getMap(repoPath: string): Promise<MapView> {
  const dir = join(repoPath, FLOORPLAN_DIR);
  const index = join(dir, "index.html");
  const ready = (await isFloorplanMap(dir)) && (await exists(index));
  let floorplanOn = false;
  try {
    floorplanOn = (await loadProfile(repoPath))?.floorplan === true;
  } catch {
    // An unreadable profile reads as off; the empty state says how to turn it on.
  }
  return {
    repoPath,
    dir,
    url: ready ? pathToFileURL(index).href : null,
    floorplanOn,
  };
}

/** The part of an Electron session the map's guard sets up. */
export interface MapSession {
  webRequest: {
    onBeforeRequest(
      listener: (
        details: { url: string },
        callback: (response: { cancel: boolean }) => void,
      ) => void,
    ): void;
  };
  setPermissionRequestHandler(
    handler: (
      webContents: unknown,
      permission: string,
      callback: (granted: boolean) => void,
    ) => void,
  ): void;
  setPermissionCheckHandler(handler: () => boolean): void;
}

/**
 * Guard the map's session: every request outside the current map directory is
 * cancelled and reported, and every permission (camera, notifications,
 * clipboard, …) is refused. `mapDir` is read per request, so switching repos
 * moves the fence with it.
 */
export function guardMapSession(
  session: MapSession,
  mapDir: () => string | null,
  onBlocked: (url: string) => void,
): void {
  session.webRequest.onBeforeRequest((details, callback) => {
    const allowed = mapRequestAllowed(details.url, mapDir());
    if (!allowed) onBlocked(details.url);
    callback({ cancel: !allowed });
  });
  session.setPermissionRequestHandler((_contents, _permission, callback) =>
    callback(false),
  );
  session.setPermissionCheckHandler(() => false);
}

/** The webview attributes and preferences `will-attach-webview` hands over. */
export interface WebviewAttach {
  params: { src?: string; partition?: string };
  webPreferences: {
    preload?: string;
    nodeIntegration?: boolean;
    nodeIntegrationInSubFrames?: boolean;
    contextIsolation?: boolean;
    sandbox?: boolean;
    webSecurity?: boolean;
    allowRunningInsecureContent?: boolean;
  };
}

/**
 * Whether a <webview> may attach: only the map's, on the map's session, loading
 * a file inside the current map directory. One that may is locked down here,
 * whatever the renderer asked for: no preload, no Node, isolated and sandboxed.
 */
export function attachMapWebview(
  attach: WebviewAttach,
  mapDir: string | null,
): boolean {
  if (attach.params.partition !== MAP_PARTITION) return false;
  if (!mapRequestAllowed(attach.params.src ?? "", mapDir)) return false;
  const prefs = attach.webPreferences;
  delete prefs.preload;
  prefs.nodeIntegration = false;
  prefs.nodeIntegrationInSubFrames = false;
  prefs.contextIsolation = true;
  prefs.sandbox = true;
  prefs.webSecurity = true;
  prefs.allowRunningInsecureContent = false;
  return true;
}

/** The blocked requests to show, newest last, at most BLOCKED_KEPT of them. */
export function keepBlocked(blocked: string[], url: string): string[] {
  return [...blocked, url].slice(-BLOCKED_KEPT);
}

/**
 * Which repo's floorplan/ the map's session is fenced to, and what it has
 * blocked since. Opening a map moves the fence, but only the latest open does:
 * picking repos quickly can't leave it on one whose read finished last.
 */
export class MapFence {
  private shown: { repoPath: string; dir: string; blocked: string[] } | null =
    null;
  private opens = 0;

  /** The floorplan/ the session may load from, or null before any map is open. */
  get dir(): string | null {
    return this.shown?.dir ?? null;
  }

  async open(
    repoPath: string,
    read: (repoPath: string) => Promise<MapView>,
  ): Promise<MapView> {
    const open = ++this.opens;
    const view = await read(repoPath);
    if (open === this.opens)
      this.shown = { repoPath, dir: view.dir, blocked: [] };
    return view;
  }

  /** Note a blocked request; returns what to tell the renderer, or null with no map open. */
  block(url: string): { repoPath: string; urls: string[] } | null {
    if (!this.shown) return null;
    this.shown.blocked = keepBlocked(this.shown.blocked, url);
    return { repoPath: this.shown.repoPath, urls: this.shown.blocked };
  }
}
