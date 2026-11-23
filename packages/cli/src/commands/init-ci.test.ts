import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";

import { runInit } from "./init.js";
import {
  type CiFacts,
  type CiPlan,
  detectCiPlan,
  renderCiWorkflow,
} from "./init-ci.js";

interface Workflow {
  on: { push: { branches: string[] } };
  jobs: Record<
    string,
    {
      if?: string;
      "timeout-minutes": number;
      strategy?: { matrix: { os: string[] } };
      steps: {
        name?: string;
        run?: string;
        uses?: string;
        with?: Record<string, unknown>;
      }[];
    }
  >;
}

const CHEAP: CiPlan = { tier: "cheap", why: "a private repo on the free plan" };
const FULL: CiPlan = { tier: "full", why: "a public repo" };
const NEXT: CiFacts = {
  packageManager: "npm",
  scripts: { dev: "next dev", build: "next build", lint: "next lint" },
  defaultBranch: "main",
  lockfile: false,
  workspace: false,
};
const render = (facts: CiFacts, plan: CiPlan) =>
  parseYaml(renderCiWorkflow(facts, plan)) as Workflow;
const names = (wf: Workflow, job: string) =>
  wf.jobs[job]!.steps.map((s) => s.name);

describe("renderCiWorkflow", () => {
  it("gives a private free-plan Next.js repo one Linux PR job and other OSes nightly", () => {
    const wf = render(NEXT, CHEAP);
    expect(Object.keys(wf.jobs)).toEqual(["ci", "other-os"]);
    expect(names(wf, "ci")).toEqual([
      "Checkout",
      "Filter paths",
      "Scope",
      "Set up Node",
      "Install",
      "Lint",
      "Build",
    ]);
    const ci = wf.jobs.ci!;
    expect(ci["timeout-minutes"]).toBeGreaterThan(0);
    expect(ci.if).toContain("draft");
    const install = ci.steps.find((s) => s.name === "Install")!;
    expect(install.run).toContain("npm ci; else npm install");
    // No lockfile yet, so no cache: setup-node fails on a cache it can't key.
    expect(ci.steps.find((s) => s.name === "Set up Node")!.with).toEqual({
      "node-version": "22",
    });
    expect(wf.jobs["other-os"]!.strategy!.matrix.os).toEqual([
      "windows-latest",
    ]);
    expect(wf.jobs["other-os"]!.if).not.toContain("push");
    expect(wf.on.push.branches).toEqual(["main"]);
  });

  it("runs every OS on each push for a public or paid repo", () => {
    const wf = render(NEXT, FULL);
    expect(wf.jobs["other-os"]!.strategy!.matrix.os).toEqual([
      "windows-latest",
      "macos-latest",
    ]);
    expect(wf.jobs["other-os"]!.if).toContain("push");
  });

  it("narrows a pnpm workspace's recursive scripts to the affected packages on PRs only", () => {
    const wf = render(
      {
        packageManager: "pnpm",
        declared: "pnpm@9.15.0",
        scripts: { test: "pnpm -r test", lint: "eslint ." },
        defaultBranch: "trunk",
        lockfile: true,
        workspace: true,
        nodeVersionFile: ".nvmrc",
      },
      CHEAP,
    );
    const ci = wf.jobs.ci!;
    expect(names(wf, "ci")).toContain("Affected packages");
    expect(ci.steps.find((s) => s.name === "Test")!.run).toBe(
      "pnpm ${{ steps.affected.outputs.filter }} --if-present run test",
    );
    // eslint . covers the repo itself, so it isn't narrowed.
    expect(ci.steps.find((s) => s.name === "Lint")!.run).toBe("pnpm run lint");
    expect(
      ci.steps.find((s) => s.name === "Set up pnpm")!.with,
    ).toBeUndefined();
    expect(ci.steps.find((s) => s.name === "Set up Node")!.with).toEqual({
      "node-version-file": ".nvmrc",
      cache: "pnpm",
    });
    const other = wf.jobs["other-os"]!;
    expect(other.steps.find((s) => s.name === "Test")!.run).toBe(
      "pnpm run test",
    );
    expect(other.steps.some((s) => s.name === "Affected packages")).toBe(false);
    expect(wf.on.push.branches).toEqual(["trunk"]);
  });

  it("gives pnpm/action-setup a version unless packageManager pins pnpm", () => {
    for (const declared of ["pnpm", "pnpm@latest", undefined]) {
      const wf = render(
        {
          packageManager: "pnpm",
          declared,
          scripts: { test: "vitest run" },
          defaultBranch: "main",
          lockfile: true,
          workspace: false,
        },
        CHEAP,
      );
      expect(
        wf.jobs.ci!.steps.find((s) => s.name === "Set up pnpm")!.with,
      ).toEqual({ version: 9 });
    }
  });

  it("skips npm's placeholder test script and gives pnpm a version when nothing declares one", () => {
    const wf = render(
      {
        ...NEXT,
        packageManager: "pnpm",
        scripts: { test: 'echo "Error: no test specified" && exit 1' },
      },
      CHEAP,
    );
    expect(names(wf, "ci")).not.toContain("Test");
    expect(
      wf.jobs.ci!.steps.find((s) => s.name === "Set up pnpm")!.with,
    ).toEqual({
      version: 9,
    });
  });
});

describe("detectCiPlan", () => {
  const github = (routes: Record<string, unknown>) =>
    vi.fn((url: string) => {
      const body = routes[url.replace("https://api.github.com", "")];
      return Promise.resolve(
        new Response(JSON.stringify(body ?? {}), {
          status: body === undefined ? 404 : 200,
        }),
      );
    }) as unknown as typeof fetch;
  const slug = { owner: "acme", repo: "web" };

  it("is cheap without a token or a slug", async () => {
    expect((await detectCiPlan(null, { token: "t" })).tier).toBe("cheap");
    expect((await detectCiPlan(slug, {})).tier).toBe("cheap");
  });

  it("is full for a public repo or a paid plan, cheap for the free plan or an unreadable one", async () => {
    const repo = (priv: boolean, type: string) => ({
      "/repos/acme/web": { private: priv, owner: { type, login: "acme" } },
    });
    const plan = async (routes: Record<string, unknown>) =>
      (await detectCiPlan(slug, { token: "t", fetch: github(routes) })).tier;
    expect(await plan(repo(false, "User"))).toBe("full");
    expect(
      await plan({
        ...repo(true, "Organization"),
        "/orgs/acme": { plan: { name: "free" } },
      }),
    ).toBe("cheap");
    expect(
      await plan({
        ...repo(true, "User"),
        "/user": { login: "Acme", plan: { name: "pro" } },
      }),
    ).toBe("full");
    // Someone else's account: its plan isn't readable.
    expect(
      await plan({
        ...repo(true, "User"),
        "/user": { login: "me", plan: { name: "pro" } },
      }),
    ).toBe("cheap");
    expect(await plan({})).toBe("cheap");
  });

  it("reads a proxy's HTML page as an unreadable plan instead of throwing", async () => {
    const html = vi.fn(() =>
      Promise.resolve(new Response("<html>", { status: 200 })),
    ) as unknown as typeof fetch;
    expect((await detectCiPlan(slug, { token: "t", fetch: html })).tier).toBe(
      "cheap",
    );
  });
});

describe("init writes CI", { timeout: 30_000 }, () => {
  const made: string[] = [];
  afterEach(async () => {
    for (const d of made) await rm(d, { recursive: true, force: true });
    made.length = 0;
    vi.restoreAllMocks();
  });
  const tmp = async (): Promise<string> => {
    const d = await mkdtemp(join(tmpdir(), "rivetari-init-ci-"));
    made.push(d);
    return d;
  };
  const nextRepo = async () => {
    const dir = await tmp();
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "web",
        packageManager: "pnpm@9.15.0",
        scripts: { dev: "next dev", build: "next build", lint: "next lint" },
      }),
    );
    return dir;
  };
  const ciPath = (dir: string) => join(dir, ".github", "workflows", "ci.yml");

  it("writes ci.yml for a Node repo without a lockfile, from packageManager and its scripts", async () => {
    const dir = await nextRepo();
    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    expect(
      await runInit(
        dir,
        { type: "web-app", yes: true },
        { token: null, detectCiPlan: () => Promise.resolve(CHEAP) },
      ),
    ).toBe(0);
    const text = await readFile(ciPath(dir), "utf8");
    expect(
      text.startsWith(
        "# Written by `rivetari init` for a private repo on the free plan.",
      ),
    ).toBe(true);
    const wf = parseYaml(text) as Workflow;
    expect(names(wf, "ci")).toContain("Set up pnpm");
    expect(wf.jobs.ci!.steps.find((s) => s.name === "Lint")!.run).toBe(
      "pnpm run lint",
    );
    expect(out.mock.calls.join("")).toContain(
      "PRs run lint, build on Linux in one job, `ci`",
    );
  });

  it("offline, assumes the cheap private setup", async () => {
    const dir = await nextRepo();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await runInit(dir, { type: "web-app", yes: true }, { token: null });
    expect(await readFile(ciPath(dir), "utf8")).toContain(
      "visibility and plan couldn't be read",
    );
    // Its own ci.yml is rewritten under --force, for the plan read now.
    await runInit(
      dir,
      { type: "web-app", yes: true, force: true },
      { token: null, detectCiPlan: () => Promise.resolve(FULL) },
    );
    expect(await readFile(ciPath(dir), "utf8")).toContain("macos-latest");
  });

  it("leaves a repo's own CI alone, and writes none for a repo without package.json", async () => {
    const dir = await nextRepo();
    const out = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await mkdir(join(dir, ".github", "workflows"), { recursive: true });
    await writeFile(
      join(dir, ".github", "workflows", "test.yml"),
      "name: test\n",
    );
    await runInit(dir, { type: "web-app", yes: true }, { token: null });
    await expect(access(ciPath(dir))).rejects.toThrow();
    expect(out.mock.calls.join("")).toContain(
      "the repo has CI of its own (.github/workflows/test.yml)",
    );

    const empty = await tmp();
    await runInit(empty, { type: "cli", yes: true }, { token: null });
    await expect(access(ciPath(empty))).rejects.toThrow();
  });
});
