import { afterEach, describe, expect, it, vi } from "vitest";

import { checkForUpdate, DESKTOP_TAG_PREFIX } from "./check";

// Signed out, GitHub won't list a private repo's releases, and the launch
// check used to throw "sign in to GitHub to read releases" on every start,
// which the main process logged as a failed IPC handler. It now resolves to
// "can't check until you sign in", with nothing thrown or logged.

function response(status: number): Response {
  return {
    ok: status < 400,
    status,
    json: () => Promise.resolve({ message: "Not Found" }),
  } as unknown as Response;
}

function check(status: number, token: string | undefined) {
  return checkForUpdate({
    fetch: vi.fn(() => Promise.resolve(response(status))),
    currentVersion: "0.1.0",
    repo: "arynbht/rivetari",
    token,
    tagPrefix: DESKTOP_TAG_PREFIX,
  });
}

describe("checkForUpdate signed out", () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([401, 403, 404])(
    "says sign-in is needed on a %i, without throwing or logging",
    async (status) => {
      const logged = vi.spyOn(console, "error");
      await expect(check(status, undefined)).resolves.toEqual({
        currentVersion: "0.1.0",
        latestVersion: null,
        updateAvailable: false,
        url: null,
        publishedAt: null,
        signInNeeded: true,
      });
      expect(logged).not.toHaveBeenCalled();
    },
  );

  it("still fails loudly when a signed-in token is refused", async () => {
    await expect(check(401, "gho_x")).rejects.toThrow(
      "update check failed: sign in to GitHub to read releases",
    );
  });

  it("still fails on a server error while signed out", async () => {
    await expect(check(500, undefined)).rejects.toThrow(
      "update check failed (500)",
    );
  });
});
