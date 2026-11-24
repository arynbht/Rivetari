// R-28: a merge head whose tree equals a judged head's had no rivetari/judge
// check, so CI ran in full and a person compared trees by hand. The check is
// carried to the new head, saying where from and why it holds.
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildContext, type GitHubClient } from "../context.js";
import { carryJudgeCheck, JUDGE_CHECK_NAME } from "./checks.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const REPO = "https://api.github.com/repos/o/r";
const JUDGED = "c082fae".padEnd(40, "0");
const MERGE = "0dc0521".padEnd(40, "0");
const TREE = "e".repeat(40);

async function client(): Promise<GitHubClient> {
  const gh = await buildContext("/tmp/x", {
    token: "t",
    github: { owner: "o", repo: "r" },
  }).github();
  if (!gh) throw new Error("expected a github client");
  return gh;
}

const green = {
  id: 9,
  name: JUDGE_CHECK_NAME,
  conclusion: "success",
  external_id: "T-0024",
  output: { title: "Judge passed T-0024 (round 1)", summary: "hashes" },
};

describe("R-28: carrying the judge check to an identical tree", () => {
  it("posts a green check on the merge head that names where it came from", async () => {
    let created: Record<string, unknown> | undefined;
    server.use(
      http.get(`${REPO}/commits/${JUDGED}/check-runs`, () =>
        HttpResponse.json({ total_count: 1, check_runs: [green] }),
      ),
      http.get(`${REPO}/commits/${MERGE}/check-runs`, () =>
        HttpResponse.json({ total_count: 0, check_runs: [] }),
      ),
      http.post(`${REPO}/check-runs`, async ({ request }) => {
        created = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: 10, html_url: "https://x/runs/10" });
      }),
    );
    expect(
      await carryJudgeCheck(await client(), {
        from: JUDGED,
        head: MERGE,
        tree: TREE,
      }),
    ).toBe("https://x/runs/10");
    expect(created).toMatchObject({
      name: JUDGE_CHECK_NAME,
      head_sha: MERGE,
      external_id: "T-0024",
      conclusion: "success",
      output: {
        title: "Judge passed T-0024 (round 1) (carried: identical tree)",
      },
    });
    expect((created?.output as { summary: string }).summary).toContain(
      `Carried from \`${JUDGED}\``,
    );
  });

  it("carries nothing when the judged head has no green check", async () => {
    server.use(
      http.get(`${REPO}/commits/${JUDGED}/check-runs`, () =>
        HttpResponse.json({ total_count: 0, check_runs: [] }),
      ),
      http.get(`${REPO}/commits/${MERGE}/check-runs`, () =>
        HttpResponse.json({ total_count: 0, check_runs: [] }),
      ),
    );
    expect(
      await carryJudgeCheck(await client(), {
        from: JUDGED,
        head: MERGE,
        tree: TREE,
      }),
    ).toBeNull();
  });
});
