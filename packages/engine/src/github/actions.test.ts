import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildContext, type GitHubClient } from "../context.js";
import {
  ciBudgetLine,
  ciBudgetSection,
  jobMinutes,
  monthCiMinutes,
  prCiMinutes,
} from "./actions.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const REPO = "https://api.github.com/repos/o/r";

async function client(): Promise<GitHubClient> {
  const gh = await buildContext("/tmp/x", {
    token: "t",
    github: { owner: "o", repo: "r" },
  }).github();
  if (!gh) throw new Error("expected a github client");
  return gh;
}

const job = (start: string, end: string, conclusion = "success") => ({
  started_at: `2026-11-20T10:${start}Z`,
  completed_at: `2026-11-20T10:${end}Z`,
  conclusion,
});

describe("jobMinutes", () => {
  it("rounds each job up to a minute and skips skipped or instant jobs", () => {
    expect(
      jobMinutes([
        job("00:00", "00:05"), // 5s bills a minute
        job("00:00", "02:01"), // 2m1s bills three
        job("00:00", "03:00", "skipped"),
        job("05:00", "05:00"),
        { started_at: null, completed_at: null, conclusion: null },
      ]),
    ).toBe(4);
  });
});

describe("prCiMinutes", () => {
  it("counts every completed run on each of the PR's commits, once", async () => {
    const jobsAsked: string[] = [];
    server.use(
      http.get(`${REPO}/pulls/9/commits`, () =>
        HttpResponse.json([{ sha: "aaa" }, { sha: "bbb" }]),
      ),
      http.get(`${REPO}/actions/runs`, ({ request }) => {
        const sha = new URL(request.url).searchParams.get("head_sha");
        const runs =
          sha === "aaa"
            ? [{ id: 1, run_attempt: 1, status: "completed" }]
            : [
                { id: 2, run_attempt: 1, status: "completed" },
                { id: 3, run_attempt: 1, status: "in_progress" },
              ];
        return HttpResponse.json({
          total_count: runs.length,
          workflow_runs: runs,
        });
      }),
      http.get(`${REPO}/actions/runs/:id/jobs`, ({ params, request }) => {
        jobsAsked.push(
          `${String(params.id)}?${new URL(request.url).searchParams.get("filter")}`,
        );
        const jobs =
          params.id === "1"
            ? [job("00:00", "04:30"), job("00:00", "00:20", "skipped")]
            : [job("00:00", "01:00"), job("00:00", "01:01")];
        return HttpResponse.json({ total_count: jobs.length, jobs });
      }),
    );

    expect(await prCiMinutes(await client(), 9)).toEqual({
      minutes: 5 + 1 + 2,
      runs: 2,
      partial: false,
    });
    // Every attempt's jobs, and never a run still going.
    expect(jobsAsked.sort()).toEqual(["1?all", "2?all"]);
  });
});

describe("monthCiMinutes", () => {
  it("lists the month's completed runs and looks up only runs it doesn't know", async () => {
    let listed: URLSearchParams | undefined;
    const jobsAsked: string[] = [];
    server.use(
      http.get(`${REPO}/actions/runs`, ({ request }) => {
        listed = new URL(request.url).searchParams;
        return HttpResponse.json({
          total_count: 3,
          workflow_runs: [
            { id: 10, run_attempt: 1, status: "completed" },
            { id: 11, run_attempt: 2, status: "completed" },
            { id: 12, run_attempt: 1, status: "completed" },
          ],
        });
      }),
      http.get(`${REPO}/actions/runs/:id/jobs`, ({ params }) => {
        jobsAsked.push(String(params.id));
        return HttpResponse.json({
          total_count: 1,
          jobs: [job("00:00", "06:00")],
        });
      }),
    );
    const known = new Map([["10/1", 30]]);

    const used = await monthCiMinutes(
      await client(),
      new Date("2026-11-23T08:00:00Z"),
      { known },
    );

    expect(listed?.get("created")).toBe(">=2026-11-01");
    expect(listed?.get("status")).toBe("completed");
    expect(jobsAsked.sort()).toEqual(["11", "12"]);
    expect(used).toEqual({
      minutes: 30 + 6 + 6,
      runs: 3,
      partial: false,
      month: "2026-11",
    });
    expect(Object.fromEntries(known)).toEqual({
      "10/1": 30,
      "11/2": 6,
      "12/1": 6,
    });
  });

  it("says it's partial when it stops at maxLookups or the API holds more runs", async () => {
    server.use(
      http.get(`${REPO}/actions/runs`, () =>
        HttpResponse.json({
          total_count: 1500,
          workflow_runs: [
            { id: 1, run_attempt: 1, status: "completed" },
            { id: 2, run_attempt: 1, status: "completed" },
          ],
        }),
      ),
      http.get(`${REPO}/actions/runs/:id/jobs`, () =>
        HttpResponse.json({ total_count: 1, jobs: [job("00:00", "01:00")] }),
      ),
    );
    const used = await monthCiMinutes(
      await client(),
      new Date("2026-11-23T08:00:00Z"),
      { maxLookups: 1 },
    );
    expect(used).toMatchObject({ minutes: 1, runs: 1, partial: true });
  });
});

describe("the status issue's CI minutes line", () => {
  const used = { minutes: 1530, runs: 212, partial: false };

  it("shows the month so far against the budget, marked past 75% and past 100%", () => {
    expect(ciBudgetLine(used, 4000)).toBe(
      "CI minutes this month: 1,530 of 4,000 (38%) over 212 run(s).",
    );
    expect(ciBudgetLine(used, 2000)).toBe(
      "⚠ CI minutes this month: 1,530 of 2,000 (77%) over 212 run(s).",
    );
    expect(ciBudgetLine({ ...used, partial: true }, 1000)).toBe(
      "⛔ CI minutes this month: at least 1,530 of 1,000 (153%) over 212 run(s).",
    );
  });

  it("says so when the Actions API couldn't be read", () => {
    expect(ciBudgetLine(null, 2000)).toContain(
      "couldn't be read from the Actions API",
    );
  });

  it("adds nothing without a budget, and never asks GitHub then", async () => {
    let asked = false;
    const ctx = {
      github: async () => {
        asked = true;
        return null;
      },
    };
    expect(await ciBudgetSection(ctx, undefined, new Date())).toBe("");
    expect(asked).toBe(false);
  });

  it("appends the line to the issue body when a budget is set", async () => {
    server.use(
      http.get(`${REPO}/actions/runs`, () =>
        HttpResponse.json({
          total_count: 1,
          workflow_runs: [{ id: 1, run_attempt: 1, status: "completed" }],
        }),
      ),
      http.get(`${REPO}/actions/runs/:id/jobs`, () =>
        HttpResponse.json({ total_count: 1, jobs: [job("00:00", "09:10")] }),
      ),
    );
    const gh = await client();
    expect(
      await ciBudgetSection(
        { github: async () => gh },
        100,
        new Date("2026-11-23T08:00:00Z"),
      ),
    ).toBe("\n\nCI minutes this month: 10 of 100 (10%) over 1 run(s).");
  });
});
