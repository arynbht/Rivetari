import { describe, expect, it, vi } from "vitest";

import {
  checkForUpdate,
  DESKTOP_TAG_PREFIX,
  latestTaggedRelease,
} from "./check";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// The release repo as it is today: the CLI's releases and nothing for desktop.
const CLI_ONLY = [
  {
    tag_name: "v2.0.0",
    html_url: "https://github.com/arynbht/rivetari/releases/tag/v2.0.0",
    published_at: "2026-11-24T04:07:07Z",
  },
  { tag_name: "v1.0.0", published_at: "2026-11-03T19:56:52Z" },
];

function check(releases: unknown, currentVersion = "0.1.0") {
  const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(releases)));
  return {
    fetchMock,
    result: checkForUpdate({
      fetch: fetchMock,
      currentVersion,
      repo: "arynbht/rivetari",
      token: undefined,
      tagPrefix: DESKTOP_TAG_PREFIX,
    }),
  };
}

describe("latestTaggedRelease", () => {
  it("picks the highest desktop version, not the first listed", () => {
    const latest = latestTaggedRelease(
      [
        { tag_name: "desktop-v0.2.0" },
        { tag_name: "desktop-v0.10.0" },
        { tag_name: "desktop-v0.9.1" },
      ],
      DESKTOP_TAG_PREFIX,
    );
    expect(latest?.version).toBe("0.10.0");
  });

  it("skips drafts, prereleases and other tags", () => {
    const latest = latestTaggedRelease(
      [
        { tag_name: "v9.0.0" },
        { tag_name: "desktop-v0.4.0", draft: true },
        { tag_name: "desktop-v0.3.0", prerelease: true },
        { tag_name: "desktop-v0.2.0" },
        null,
        "desktop-v5.0.0",
      ],
      DESKTOP_TAG_PREFIX,
    );
    expect(latest?.version).toBe("0.2.0");
  });

  it("returns null when no release carries the prefix", () => {
    expect(latestTaggedRelease(CLI_ONLY, DESKTOP_TAG_PREFIX)).toBe(null);
  });
});

describe("checkForUpdate with the desktop tag prefix", () => {
  it("lists releases instead of asking for the latest one", async () => {
    const { fetchMock, result } = check(CLI_ONLY);
    await result;
    const url = String((fetchMock.mock.calls[0] as unknown[])[0]);
    expect(url).toContain("/repos/arynbht/rivetari/releases?");
    expect(url).not.toContain("/releases/latest");
  });

  it("reports no update when only the CLI has released", async () => {
    const { result } = check(CLI_ONLY);
    const info = await result;
    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBe(null);
    expect(info.url).toBe(null);
  });

  it("reports a newer desktop release with its version and page", async () => {
    const { result } = check([
      ...CLI_ONLY,
      {
        tag_name: "desktop-v0.2.0",
        html_url:
          "https://github.com/arynbht/rivetari/releases/tag/desktop-v0.2.0",
        published_at: "2026-12-01T00:00:00Z",
      },
    ]);
    const info = await result;
    expect(info.updateAvailable).toBe(true);
    expect(info.latestVersion).toBe("0.2.0");
    expect(info.url).toContain("desktop-v0.2.0");
    expect(info.publishedAt).toBe("2026-12-01T00:00:00Z");
  });

  it("reports up to date when the newest desktop release is this version", async () => {
    const { result } = check([...CLI_ONLY, { tag_name: "desktop-v0.1.0" }]);
    const info = await result;
    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBe("0.1.0");
  });

  it("ignores a newer desktop prerelease", async () => {
    const { result } = check([
      { tag_name: "desktop-v0.2.0-beta.1", prerelease: true },
      { tag_name: "desktop-v0.1.0" },
    ]);
    const info = await result;
    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBe("0.1.0");
  });

  it("treats a body that isn't a list as no release", async () => {
    const { result } = check({ message: "unexpected" });
    const info = await result;
    expect(info.updateAvailable).toBe(false);
    expect(info.latestVersion).toBe(null);
  });
});
