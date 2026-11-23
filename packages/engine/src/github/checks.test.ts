import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildContext, type GitHubClient } from "../context.js";
import { JUDGE_CHECK_NAME, postJudgeCheck } from "./checks.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const REPO = "https://api.github.com/repos/o/r";
const HEAD = "a".repeat(40);
const params = {
  head: HEAD,
  task: "T-0007",
  round: 2,
  recordSha256: "b".repeat(64),
  ledgerHash: "c".repeat(64),
};

async function client(): Promise<GitHubClient> {
  const gh = await buildContext("/tmp/x", {
    token: "t",
    github: { owner: "o", repo: "r" },
  }).github();
  if (!gh) throw new Error("expected a github client");
  return gh;
}

describe("postJudgeCheck", () => {
  it("posts a successful rivetari/judge check on the head with both hashes", async () => {
    let listedName: string | null = null;
    let created: Record<string, unknown> | undefined;
    server.use(
      http.get(`${REPO}/commits/${HEAD}/check-runs`, ({ request }) => {
        listedName = new URL(request.url).searchParams.get("check_name");
        return HttpResponse.json({ total_count: 0, check_runs: [] });
      }),
      http.post(`${REPO}/check-runs`, async ({ request }) => {
        created = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({
          id: 1,
          html_url: "https://github.com/o/r/runs/1",
        });
      }),
    );

    expect(await postJudgeCheck(await client(), params)).toBe(
      "https://github.com/o/r/runs/1",
    );
    expect(listedName).toBe("rivetari/judge");
    expect(created).toMatchObject({
      name: JUDGE_CHECK_NAME,
      head_sha: HEAD,
      external_id: "T-0007",
      status: "completed",
      conclusion: "success",
    });
    expect(JUDGE_CHECK_NAME).toBe("rivetari/judge");
    const summary = (created?.output as { summary: string }).summary;
    expect(summary).toContain(`Judge record sha256: \`${"b".repeat(64)}\``);
    expect(summary).toContain(`Ledger hash: \`${"c".repeat(64)}\``);
  });

  it("posts nothing when the head already has this task's passing check", async () => {
    let posted = false;
    server.use(
      http.get(`${REPO}/commits/${HEAD}/check-runs`, () =>
        HttpResponse.json({
          total_count: 1,
          check_runs: [{ conclusion: "success", external_id: "T-0007" }],
        }),
      ),
      http.post(`${REPO}/check-runs`, () => {
        posted = true;
        return HttpResponse.json({});
      }),
    );
    expect(await postJudgeCheck(await client(), params)).toBeNull();
    expect(posted).toBe(false);
  });
});
