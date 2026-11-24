import type { Control } from "@arynbht/rivetari-catalog";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { buildContext } from "../context.js";
import { evaluateControl } from "../evaluate.js";
import { githubApi } from "./github-api.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const REPO = "https://api.github.com/repos/o/r";
const PROTECTION = `${REPO}/branches/main/protection`;
const RULES = `${REPO}/rules/branches/main`;

const UPGRADE = {
  message:
    "Upgrade to GitHub Pro or make this repository public to enable this feature.",
  documentation_url: "https://docs.github.com/rest/branches/branch-protection",
};

const CHECKS = [
  "branch-protection",
  "required-pull-request",
  "required-status-checks",
] as const;

function ctx() {
  return buildContext("/virtual/repo", {
    token: "dummy",
    github: { owner: "o", repo: "r" },
  });
}

function repoHandler(isPrivate: boolean) {
  return http.get(REPO, () =>
    HttpResponse.json({
      default_branch: "main",
      private: isPrivate,
      visibility: isPrivate ? "private" : "public",
    }),
  );
}

const upgrade403 = () => HttpResponse.json(UPGRADE, { status: 403 });
const notProtected = () =>
  HttpResponse.json({ message: "Branch not protected" }, { status: 404 });
const forbidden = () =>
  HttpResponse.json(
    { message: "Resource not accessible by integration" },
    {
      status: 403,
    },
  );

describe("github-api protection checks on GitHub's free plan", () => {
  describe("A1: a private repo answered with the plan-upgrade 403", () => {
    it.each(CHECKS)("%s reports n/a naming the free plan", async (check) => {
      server.use(
        repoHandler(true),
        http.get(PROTECTION, upgrade403),
        http.get(RULES, upgrade403),
      );
      const result = await githubApi(ctx(), { type: "github-api", check });
      expect(result.status).toBe("n/a");
      expect(result.message).toMatch(/free plan/i);
    });

    it.each(CHECKS)(
      "%s reports n/a when only the protection endpoint asks for the upgrade",
      async (check) => {
        server.use(
          repoHandler(true),
          http.get(PROTECTION, upgrade403),
          http.get(RULES, () => HttpResponse.json([])),
        );
        const result = await githubApi(ctx(), { type: "github-api", check });
        expect(result.status).toBe("n/a");
        expect(result.message).toMatch(/free plan/i);
      },
    );

    it("reads the control as n/a, which the gate does not count against", async () => {
      server.use(
        repoHandler(true),
        http.get(PROTECTION, upgrade403),
        http.get(RULES, upgrade403),
      );
      const control = {
        id: "repo.branch-protection",
        title: "Default branch is protected",
        lane: "hygiene",
        phase: "scaffold",
        severity: "high",
        detect: [{ type: "github-api", check: "branch-protection" }],
        evidence: "none",
        references: [{ name: "ref", url: "https://example.com" }],
        rationale: "because",
      } as Control;
      const result = await evaluateControl(control, ctx());
      expect(result.status).toBe("n/a");
      expect(result.detectors[0]?.message).toMatch(/free plan/i);
    });

    it("still passes when a ruleset protects the branch", async () => {
      server.use(
        repoHandler(true),
        http.get(PROTECTION, upgrade403),
        http.get(RULES, () =>
          HttpResponse.json([
            { type: "pull_request" },
            { type: "required_status_checks" },
          ]),
        ),
      );
      for (const check of CHECKS) {
        const result = await githubApi(ctx(), { type: "github-api", check });
        expect(result.status).toBe("pass");
      }
    });
  });

  describe("A2: public repos and paid plans are unchanged", () => {
    it.each(CHECKS)(
      "%s still fails on a public repo with no protection",
      async (check) => {
        server.use(
          repoHandler(false),
          http.get(PROTECTION, notProtected),
          http.get(RULES, () => HttpResponse.json([])),
        );
        const result = await githubApi(ctx(), { type: "github-api", check });
        expect(result.status).toBe("fail");
      },
    );

    it.each(CHECKS)(
      "%s still fails on a private paid-plan repo with no protection",
      async (check) => {
        server.use(
          repoHandler(true),
          http.get(PROTECTION, notProtected),
          http.get(RULES, () => HttpResponse.json([])),
        );
        const result = await githubApi(ctx(), { type: "github-api", check });
        expect(result.status).toBe("fail");
      },
    );

    it.each(CHECKS)(
      "%s does not read a plan-upgrade 403 on a public repo as n/a",
      async (check) => {
        server.use(
          repoHandler(false),
          http.get(PROTECTION, upgrade403),
          http.get(RULES, upgrade403),
        );
        const result = await githubApi(ctx(), { type: "github-api", check });
        expect(result.status).toBe("skip");
        expect(result.message).toMatch(/HTTP 403/);
      },
    );
  });

  describe("A3: any other 403 or error is unchanged", () => {
    it.each(CHECKS)(
      "%s skips for want of an admin token on another 403",
      async (check) => {
        server.use(
          repoHandler(true),
          http.get(PROTECTION, forbidden),
          http.get(RULES, () => HttpResponse.json([])),
        );
        const result = await githubApi(ctx(), { type: "github-api", check });
        expect(result.status).toBe("skip");
        expect(result.message).toMatch(/admin token/i);
      },
    );

    it.each(CHECKS)(
      "%s skips with the permission message when both endpoints deny",
      async (check) => {
        server.use(
          repoHandler(true),
          http.get(PROTECTION, forbidden),
          http.get(RULES, forbidden),
        );
        const result = await githubApi(ctx(), { type: "github-api", check });
        expect(result.status).toBe("skip");
        expect(result.message).toMatch(/insufficient permission.*HTTP 403/i);
      },
    );

    it.each(CHECKS)(
      "%s skips when the rules endpoint errors after a plan-upgrade 403",
      async (check) => {
        server.use(
          repoHandler(true),
          http.get(PROTECTION, upgrade403),
          http.get(RULES, () =>
            HttpResponse.json({ message: "Server Error" }, { status: 500 }),
          ),
        );
        const result = await githubApi(ctx(), { type: "github-api", check });
        expect(result.status).toBe("skip");
        expect(result.message).toMatch(/failed/i);
      },
    );
  });
});
