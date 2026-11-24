import { describe, expect, it, vi } from "vitest";

import { TaskPrState } from "../../shared/ipc";
import { type PrClient, type PrDeps, prState } from "./task-pr";

// A task's PR as GitHub has it: only for a person signed in, through
// githubToken() with their token as the explicit one, and never a throw.

const PR = { number: 42, url: "https://github.com/o/r/pull/42" };

const deps = (client: Partial<PrClient> = {}, over: Partial<PrDeps> = {}) => {
  const full: PrClient = {
    pull: vi.fn(async () => ({
      state: "open",
      merged: false,
      draft: true,
      mergeable: true,
      mergeableState: "clean",
      headSha: "abcdef0123456789",
    })),
    checkRuns: vi.fn(async () => [
      {
        name: "ci",
        status: "completed",
        conclusion: "success",
        head_sha: "abcdef0123456789",
      },
      {
        name: "e2e",
        status: "in_progress",
        conclusion: null,
        head_sha: "abcdef0123456789",
      },
    ]),
    ...client,
  };
  return {
    client: full,
    deps: {
      resolveRepoSlug: vi.fn(async () => ({ owner: "o", repo: "r" })),
      githubToken: vi.fn(async () => ({ token: "t", source: "explicit" })),
      client: vi.fn(() => full),
      ...over,
    } as unknown as PrDeps,
  };
};

describe("a task's PR on GitHub", () => {
  it("has its state, draft and mergeable, and the check runs on its head", async () => {
    const { deps: d, client } = deps();
    const state = TaskPrState.parse(await prState("/repo", PR, "me", d));
    expect(state).toEqual({
      state: "open",
      number: 42,
      draft: true,
      mergeable: true,
      mergeableState: "clean",
      headSha: "abcdef0123456789",
      checks: [
        {
          name: "ci",
          status: "completed",
          conclusion: "success",
          headSha: "abcdef0123456789",
        },
        {
          name: "e2e",
          status: "in_progress",
          conclusion: null,
          headSha: "abcdef0123456789",
        },
      ],
      detail: "PR #42 is open as a draft, mergeable (clean)",
    });
    expect(d.githubToken).toHaveBeenCalledWith("/repo", "me");
    expect(client.checkRuns).toHaveBeenCalledWith("o", "r", "abcdef0123456789");
  });

  it("says merged, closed, or that GitHub is still working out mergeability", async () => {
    const at = (pull: Partial<Awaited<ReturnType<PrClient["pull"]>>>) =>
      deps({
        pull: vi.fn(async () => ({
          state: "open",
          merged: false,
          draft: false,
          mergeable: null,
          mergeableState: "unknown",
          headSha: "1",
          ...pull,
        })),
      }).deps;
    expect(
      (await prState("/r", PR, "me", at({ merged: true, state: "closed" })))
        .state,
    ).toBe("merged");
    expect(
      await prState("/r", PR, "me", at({ state: "closed" })),
    ).toMatchObject({
      state: "closed",
      detail: "PR #42 was closed unmerged",
    });
    expect((await prState("/r", PR, "me", at({}))).detail).toBe(
      "PR #42 is open, GitHub is still working out whether it can merge",
    );
  });

  it("reads nothing with no PR or no sign-in, and says why it can't read", async () => {
    const { deps: d } = deps();
    expect((await prState("/r", null, "me", d)).state).toBe("none");
    expect(await prState("/r", PR, null, d)).toMatchObject({
      state: "signed-out",
      number: 42,
      detail: "sign in to see the PR's state and checks",
    });
    expect(d.client).not.toHaveBeenCalled();

    const noOrigin = deps(
      {},
      { resolveRepoSlug: vi.fn(async () => null) },
    ).deps;
    expect((await prState("/r", PR, "me", noOrigin)).state).toBe("unavailable");

    const failing = deps({
      pull: vi.fn(async () => {
        throw new Error("Not Found");
      }),
    }).deps;
    expect(await prState("/r", PR, "me", failing)).toMatchObject({
      state: "unavailable",
      detail: "the PR couldn't be read: Not Found",
      checks: [],
    });
  });
});
