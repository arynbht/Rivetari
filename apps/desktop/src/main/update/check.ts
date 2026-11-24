// Manual update check (ADR-0010, private-repo path). electron-updater can't read a
// private repo's releases, so we query the GitHub Releases API with the user's
// token and report whether a newer release exists. Pure: `fetch` is injectable so
// the version comparison is unit-tested without the network.
//
// Rivetari's release repo also carries the CLI's releases (v2.0.0 and so on),
// which have no desktop download, so the app passes a tag prefix and only
// releases tagged `desktop-v*` count. Until one is published there is nothing to
// update to.
import type { UpdateInfo } from "../../shared/ipc";

const GITHUB_API = "https://api.github.com";

/** The tag prefix desktop releases are published under. */
export const DESKTOP_TAG_PREFIX = "desktop-v";

export interface UpdateCheckDeps {
  fetch: typeof globalThis.fetch;
  /** The running app version (e.g. app.getVersion()). */
  currentVersion: string;
  /** owner/repo of the release repo. */
  repo: string;
  /** GitHub token; private release repos require it. */
  token: string | undefined;
  /**
   * Only releases whose tag starts with this count, and the version is the rest
   * of the tag. Without it the repo's latest release is taken, which suits a
   * repo that releases nothing but the desktop app.
   */
  tagPrefix?: string;
}

interface Release {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  published_at?: unknown;
  draft?: unknown;
  prerelease?: unknown;
}

/** Strip a leading `v`/`name@` and split into numeric segments for comparison. */
function parseVersion(raw: string): number[] {
  const cleaned = raw
    .trim()
    .replace(/^.*@/, "") // drop a `pkg@` prefix if the tag carries one
    .replace(/^v/i, "")
    .split("-")[0]; // ignore a prerelease suffix for ordering
  return (cleaned ?? "")
    .split(".")
    .map((n) => Number.parseInt(n, 10))
    .map((n) => (Number.isNaN(n) ? 0 : n));
}

/** True when `latest` is strictly newer than `current` (semver-ish). */
export function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/**
 * The newest published release in a releases listing whose tag starts with
 * `prefix`, with the prefix stripped from its version. Drafts and prereleases
 * never count. Null when there is none.
 */
export function latestTaggedRelease(
  releases: unknown[],
  prefix: string,
): { version: string; release: Release } | null {
  let best: { version: string; release: Release } | null = null;
  for (const item of releases) {
    if (!item || typeof item !== "object") continue;
    const release = item as Release;
    if (release.draft === true || release.prerelease === true) continue;
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    if (!tag.startsWith(prefix)) continue;
    const version = tag.slice(prefix.length);
    if (!best || isNewer(version, best.version)) best = { version, release };
  }
  return best;
}

export async function checkForUpdate(
  deps: UpdateCheckDeps,
): Promise<UpdateInfo> {
  const base: UpdateInfo = {
    currentVersion: deps.currentVersion,
    latestVersion: null,
    updateAvailable: false,
    url: null,
    publishedAt: null,
  };

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "rivetari-desktop",
  };
  if (deps.token) headers.Authorization = `Bearer ${deps.token}`;

  // `releases/latest` is whatever the repo released last, so with a prefix the
  // releases are listed and filtered instead. A page of 100 reaches back far
  // enough for this repo.
  const res = await deps.fetch(
    deps.tagPrefix === undefined
      ? `${GITHUB_API}/repos/${deps.repo}/releases/latest`
      : `${GITHUB_API}/repos/${deps.repo}/releases?per_page=100`,
    { headers },
  );

  // Signed out, GitHub refuses a private repo's listing (401/403, or a 404 for
  // the listing itself) and rate-limits anonymous calls with a 403. None of
  // that is a failure of the app, so it's said quietly rather than thrown: a
  // launch check runs on every start and the person can't act on it but by
  // signing in.
  if (
    !deps.token &&
    (res.status === 401 ||
      res.status === 403 ||
      (res.status === 404 && deps.tagPrefix !== undefined))
  )
    return { ...base, signInNeeded: true };
  // No published (non-draft) release yet → nothing to update to, not an error.
  if (res.status === 404) return base;
  if (!res.ok) {
    throw new Error(
      res.status === 401 || res.status === 403
        ? "update check failed: sign in to GitHub to read releases"
        : `update check failed (${res.status})`,
    );
  }

  let version: string;
  let release: Release;
  if (deps.tagPrefix === undefined) {
    release = (await res.json()) as Release;
    if (release.draft === true) return base;
    if (typeof release.tag_name !== "string" || !release.tag_name) return base;
    version = release.tag_name;
  } else {
    const data: unknown = await res.json();
    const latest = latestTaggedRelease(
      Array.isArray(data) ? data : [],
      deps.tagPrefix,
    );
    if (!latest) return base;
    ({ version, release } = latest);
  }

  return {
    currentVersion: deps.currentVersion,
    latestVersion: version,
    updateAvailable: isNewer(version, deps.currentVersion),
    url: typeof release.html_url === "string" ? release.html_url : null,
    publishedAt:
      typeof release.published_at === "string" ? release.published_at : null,
  };
}
