// Map adapter: the floorplan skill's static map of the repo (floorplan/index.html,
// drawn at init and on a merged close when the profile has `floorplan: true`),
// shown in a <webview> on its own session. The map's server (serve.mjs) is the
// only part of floorplan that reaches the network and is never started; the page
// itself still has buttons that would ("Notify me" posts to the waitlist), so
// the map's session cancels every request that isn't a file inside that repo's
// floorplan/. Electron-free: the session and webview hooks take what they use.
import { access } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadProfile } from "@arynbht/rivetari-engine";
import { FLOORPLAN_DIR, isFloorplanMap } from "@arynbht/rivetari-runtime";

import type { MapView } from "../../shared/ipc";

/** The map's session: in memory only, shared by nothing else in the app. */
export const MAP_PARTITION = "rivetari-map";
/** How many blocked requests are kept to show; a chatty page can't grow it without end. */
const BLOCKED_KEPT = 50;

/**
 * True only for a file:// URL naming a file inside `mapDir`: no other scheme
 * (http, https, ws, data, a custom one), no file on another host (a UNC share)
 * and no path that leaves the directory.
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
  const rel = relative(mapDir, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
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
