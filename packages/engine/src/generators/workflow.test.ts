// The CI posture controls run against small repos: each fails on a workflow
// that lacks the shape, passes on one that has it, and passes after its fix.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Control, loadBundledCatalog } from "@arynbht/rivetari-catalog";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { parse, parseDocument } from "yaml";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import { evaluateControls } from "../audit.js";
import { buildContext } from "../context.js";
import { applyChanges } from "./apply.js";
import { planControls } from "./run.js";
import { renderTemplate, templateVars } from "./template.js";
import { pinActions, workflowGenerator } from "./workflow.js";

const REPO = "https://api.github.com/repos/o/r";
const SHA = "0123456789abcdef0123456789abcdef01234567";
let isPrivate = true;
const server = setupServer(
  http.get(REPO, () => HttpResponse.json({ private: isPrivate })),
  http.get(
    "https://api.github.com/repos/:owner/:repo/commits/:ref",
    ({ params }) =>
      params.ref === "v4"
        ? HttpResponse.json({ sha: SHA })
        : new HttpResponse(null, { status: 404 }),
  ),
);
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterAll(() => server.close());
beforeEach(() => {
  isPrivate = true;
});

const made: string[] = [];
afterEach(async () => {
  server.resetHandlers();
  for (const d of made) await rm(d, { recursive: true, force: true });
  made.length = 0;
});

async function repoWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "rivetari-posture-"));
  made.push(dir);
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(dir, path, ".."), { recursive: true });
    await writeFile(join(dir, path), contents, "utf8");
  }
  return dir;
}

const ctx = (dir: string) =>
  buildContext(dir, { token: "t", github: { owner: "o", repo: "r" } });

const POSTURE = [
  "ci.required-aggregator",
  "ci.concurrency-pr-only",
  "ci.job-timeouts",
  "ci.docs-skip-build",
  "ci.pr-linux-only",
  "ci.secret-scan-on-pr",
  "ci.actions-pinned-sha",
] as const;

// These two only suggest a change: which jobs may skip, and which job is
// required, is the repo's call.
const SUGGESTED = ["ci.docs-skip-build", "ci.pr-linux-only"] as const;
const AUTOMATIC = POSTURE.filter(
  (id) => !(SUGGESTED as readonly string[]).includes(id),
);

let catalog: Control[];
beforeAll(async () => {
  catalog = (await loadBundledCatalog()).controls;
});

function control(id: string): Control {
  const found = catalog.find((c) => c.id === id);
  if (!found) throw new Error(`no control ${id}`);
  return found;
}

async function statusOf(dir: string, id: string): Promise<string> {
  const [result] = await evaluateControls([control(id)], ctx(dir), {
    profile: null,
    waivers: [],
  });
  return result?.status ?? "missing";
}

async function fix(dir: string, id: string): Promise<void> {
  const changes = await workflowGenerator(ctx(dir), control(id));
  await applyChanges(dir, changes, { mode: "write" });
}

// A plain CI workflow: tag-pinned, no aggregator, cancels main runs, no
// timeouts or path filter, Windows on every PR, no secret scan.
const LEGACY = `name: CI

on:
  pull_request:
  push:
    branches: [main]

# Cancel superseded runs.
concurrency:
  group: \${{ github.workflow }}-\${{ github.ref }}
  cancel-in-progress: true

jobs:
  build:
    runs-on: \${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
    steps:
      - uses: actions/checkout@v4
      - run: npm test
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm run lint
`;

// The shape the controls ask for.
const SHAPED = `name: CI
on:
  pull_request:
  push:
    branches: [main]
concurrency:
  group: \${{ github.workflow }}-\${{ github.event_name == 'pull_request' && github.ref || github.sha }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
jobs:
  changes:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    outputs:
      code: \${{ steps.filter.outputs.code }}
    steps:
      - id: filter
        uses: dorny/paths-filter@ceb8a2b8f2d89434be7ff52d3de7ec3738c5cc9d # v4.0.3
        with:
          filters: |
            code: ["**", "!docs/**"]
  test:
    needs: changes
    if: needs.changes.outputs.code == 'true'
    runs-on: \${{ matrix.os }}
    timeout-minutes: 30
    strategy:
      matrix:
        os: \${{ github.event_name == 'pull_request' && fromJSON('["ubuntu-latest"]') || fromJSON('["ubuntu-latest","windows-latest"]') }}
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0
      - run: npm test
  release-mac:
    if: github.event_name != 'pull_request'
    runs-on: macos-latest
    timeout-minutes: 30
    steps:
      - run: make dmg
  secret-scan:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: gitleaks/gitleaks-action@ff98106e4c7b2bc287b24eaf42907196329070c7 # v2.3.9
  ci:
    if: always()
    needs: [changes, test, secret-scan]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - env:
          RESULTS: \${{ join(needs.*.result, ' ') }}
        run: for r in $RESULTS; do [ "$r" = success ] || [ "$r" = skipped ] || exit 1; done
`;

const WF = ".github/workflows/ci.yml";

describe("CI posture controls", () => {
  it.each(AUTOMATIC)(
    "%s fails on a plain workflow and its fix makes it pass",
    async (id) => {
      const dir = await repoWith({ [WF]: LEGACY });
      expect(await statusOf(dir, id)).toBe("fail");
      await fix(dir, id);
      expect(await statusOf(dir, id)).toBe("pass");
      // The fix keeps the file's comments and is idempotent.
      const after = await readFile(join(dir, WF), "utf8");
      expect(after).toContain("# Cancel superseded runs.");
      expect(await workflowGenerator(ctx(dir), control(id))).toEqual([]);
    },
  );

  it.each(SUGGESTED)(
    "%s fails on a plain workflow and its fix only suggests the change",
    async (id) => {
      const dir = await repoWith({ [WF]: LEGACY });
      expect(await statusOf(dir, id)).toBe("fail");
      const changes = await workflowGenerator(ctx(dir), control(id));
      expect(changes).toEqual([
        expect.objectContaining({
          type: "note",
          message: expect.stringContaining(WF),
        }),
      ]);
      await applyChanges(dir, changes, { mode: "write" });
      expect(await readFile(join(dir, WF), "utf8")).toBe(LEGACY);
      expect(await statusOf(dir, id)).toBe("fail");
    },
  );

  it.each(POSTURE)("%s passes on a workflow with the shape", async (id) => {
    const dir = await repoWith({ [WF]: SHAPED });
    expect(await statusOf(dir, id)).toBe("pass");
  });

  it("every fix together converges, and the result is a valid workflow", async () => {
    const dir = await repoWith({ [WF]: LEGACY });
    const controls = POSTURE.map(control);
    const { changes, errors } = await planControls(ctx(dir), controls);
    expect(errors).toEqual([]);
    await applyChanges(dir, changes, { mode: "write" });
    const results = await evaluateControls(controls, ctx(dir), {
      profile: null,
      waivers: [],
    });
    expect(
      Object.fromEntries(results.map((r) => [r.controlId, r.status])),
    ).toEqual({
      ...Object.fromEntries(AUTOMATIC.map((id) => [id, "pass"])),
      ...Object.fromEntries(SUGGESTED.map((id) => [id, "fail"])),
    });

    const doc = parse(await readFile(join(dir, WF), "utf8")) as {
      jobs: Record<string, { needs?: string[]; if?: string }>;
    };
    expect(Object.keys(doc.jobs)).toEqual([
      "build",
      "lint",
      "secret-scan",
      "ci",
    ]);
    expect(doc.jobs.ci?.needs).toEqual(
      expect.arrayContaining(["build", "lint", "secret-scan"]),
    );
    expect(doc.jobs.ci?.if).toBe("always()");
    // Nothing is gated on paths or kept off PRs automatically.
    expect(doc.jobs.lint?.if).toBeUndefined();
    expect(doc.jobs.build?.if).toBeUndefined();
  });

  it("the CI workflow Rivetari writes has the shape", async () => {
    const [ci] = await renderTemplate(
      "ci-workflow",
      templateVars(null, 2026, { stack: ["node"], scripts: ["test"] }),
      "ci.workflow.present",
    );
    const dir = await repoWith({
      [WF]: ci?.type === "file" ? ci.contents : "",
    });
    for (const id of [
      "ci.required-aggregator",
      "ci.concurrency",
      "ci.concurrency-pr-only",
      "ci.job-timeouts",
      "ci.actions-pinned-sha",
    ]) {
      expect([id, await statusOf(dir, id)]).toEqual([id, "pass"]);
    }
  });

  it("leaves Windows on PRs alone in a public repo", async () => {
    isPrivate = false;
    const dir = await repoWith({ [WF]: LEGACY });
    expect(await statusOf(dir, "ci.pr-linux-only")).toBe("pass");
    expect(
      await workflowGenerator(ctx(dir), control("ci.pr-linux-only")),
    ).toEqual([]);
  });

  it("suggests how to keep Windows off PRs and names the jobs", async () => {
    const dir = await repoWith({ [WF]: LEGACY });
    const [change] = await workflowGenerator(
      ctx(dir),
      control("ci.pr-linux-only"),
    );
    const message = (change as { message: string }).message;
    expect(message).toContain("`build` run on Windows or macOS");
    expect(message).toContain("matrix.os");
    expect(message).toContain("if: github.event_name != 'pull_request'");
  });

  it("turns an existing working `ci` job into the aggregator", async () => {
    const dir = await repoWith({
      [WF]: `on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: npm run lint
`,
    });
    expect(await statusOf(dir, "ci.required-aggregator")).toBe("fail");
    await fix(dir, "ci.required-aggregator");
    const doc = parse(await readFile(join(dir, WF), "utf8")) as {
      jobs: { ci: { needs: string[]; if: string; steps: { name?: string }[] } };
    };
    expect(doc.jobs.ci.needs).toEqual(["test"]);
    expect(doc.jobs.ci.if).toBe("always()");
    expect(doc.jobs.ci.steps[0]?.name).toBe("Fail if a needed job failed");
    expect(await statusOf(dir, "ci.required-aggregator")).toBe("pass");
  });

  it("only allows cancel-in-progress: true on a PR-only workflow", async () => {
    const dir = await repoWith({
      [WF]: `on: [pull_request]
concurrency:
  group: pr-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  ci:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo
`,
    });
    expect(await statusOf(dir, "ci.concurrency-pr-only")).toBe("pass");
  });

  it.each([
    [
      "the inverse condition",
      "ci-${{ github.event_name == 'pull_request' && github.ref || github.sha }}",
      "${{ github.event_name != 'pull_request' }}",
    ],
    [
      "default-branch runs grouped by ref",
      "ci-${{ github.ref }}",
      "${{ github.event_name == 'pull_request' }}",
    ],
  ])("fails concurrency with %s", async (_label, group, cancel) => {
    const dir = await repoWith({
      [WF]: `on: [pull_request, push]
concurrency:
  group: "${group}"
  cancel-in-progress: "${cancel}"
jobs:
  ci:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo
`,
    });
    expect(await statusOf(dir, "ci.concurrency-pr-only")).toBe("fail");
    await fix(dir, "ci.concurrency-pr-only");
    expect(await statusOf(dir, "ci.concurrency-pr-only")).toBe("pass");
  });

  it("fails a `ci` job that runs after a failure but never reads the results", async () => {
    const dir = await repoWith({
      [WF]: `on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: exit 1
  ci:
    if: always()
    needs: [test]
    runs-on: ubuntu-latest
    steps:
      - run: echo done
`,
    });
    expect(await statusOf(dir, "ci.required-aggregator")).toBe("fail");
    await fix(dir, "ci.required-aggregator");
    expect(await statusOf(dir, "ci.required-aggregator")).toBe("pass");
  });

  it("doesn't count a self-hosted Windows runner as paid", async () => {
    const dir = await repoWith({
      [WF]: `on: [pull_request]
jobs:
  win:
    runs-on: [self-hosted, windows]
    timeout-minutes: 5
    steps:
      - run: echo hi
`,
    });
    expect(await statusOf(dir, "ci.pr-linux-only")).toBe("pass");
  });

  it("fails a group that's per commit on PRs too", async () => {
    const dir = await repoWith({
      [WF]: `on: [pull_request, push]
concurrency:
  group: ci-\${{ github.sha }}
  cancel-in-progress: \${{ github.event_name == 'pull_request' }}
jobs:
  ci:
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - run: echo
`,
    });
    expect(await statusOf(dir, "ci.concurrency-pr-only")).toBe("fail");
  });

  it.each([
    ["no `ci` job", "build"],
    ["a plain `ci` job", "ci"],
  ])(
    "leaves the jobs ungated and asks for an aggregator with %s",
    async (_label, key) => {
      const workflow = `on: [pull_request]
jobs:
  ${key}:
    runs-on: \${{ matrix.os }}
    timeout-minutes: 10
    strategy:
      matrix:
        os: [ubuntu-latest]
    steps:
      - run: npm test
  lint:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: npm run lint
`;
      const dir = await repoWith({ [WF]: workflow });
      const changes = await workflowGenerator(
        ctx(dir),
        control("ci.docs-skip-build"),
      );
      // A gated job would be the required check itself: a skipped matrix job
      // never reports its leg's name, and a failed `changes` reads as passed.
      expect(changes).toEqual([
        expect.objectContaining({
          type: "note",
          message: expect.stringContaining(
            "first make `ci` an `always()` aggregator",
          ),
        }),
      ]);
      await applyChanges(dir, changes, { mode: "write" });
      expect(await readFile(join(dir, WF), "utf8")).toBe(workflow);
    },
  );

  it("suggests gating the jobs behind an always() aggregator", async () => {
    const dir = await repoWith({
      [WF]: `on: [pull_request]
jobs:
  e2e:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - run: npm run e2e
  ci:
    if: always()
    needs: [e2e]
    runs-on: ubuntu-latest
    timeout-minutes: 5
    steps:
      - env:
          RESULTS: \${{ join(needs.*.result, ' ') }}
        run: for r in $RESULTS; do [ "$r" = success ] || [ "$r" = skipped ] || exit 1; done
`,
    });
    const before = await readFile(join(dir, WF), "utf8");
    const changes = await workflowGenerator(
      ctx(dir),
      control("ci.docs-skip-build"),
    );
    expect(changes).toHaveLength(1);
    const message = (changes[0] as { message: string }).message;
    expect(message).not.toContain("first make");
    expect(message).toContain("dorny/paths-filter@");
    expect(message).toContain(
      "give `e2e` `needs: changes` and `if: needs.changes.outputs.code == 'true'`",
    );
    // The required `ci` job is never among the jobs to gate.
    expect(message).not.toContain("`ci` `needs: changes`");
    await applyChanges(dir, changes, { mode: "write" });
    expect(await readFile(join(dir, WF), "utf8")).toBe(before);
  });

  it("makes an aggregator gated on a need's output run on every PR", async () => {
    const dir = await repoWith({
      [WF]: `on: [pull_request]
jobs:
  changes:
    runs-on: ubuntu-latest
    steps:
      - run: echo
  ci:
    needs: [changes]
    if: needs.changes.outputs.code == 'true'
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`,
    });
    await fix(dir, "ci.required-aggregator");
    const doc = parse(await readFile(join(dir, WF), "utf8")) as {
      jobs: { ci: { if: string } };
    };
    expect(doc.jobs.ci.if).toBe("always()");
  });

  it("says to move a Windows `ci` job to Linux rather than off PRs", async () => {
    const workflow = `on: [pull_request]
jobs:
  ci:
    runs-on: windows-latest
    timeout-minutes: 10
    steps:
      - run: npm test
  installer:
    runs-on: windows-latest
    timeout-minutes: 10
    steps:
      - run: build.cmd
`;
    const dir = await repoWith({ [WF]: workflow });
    const changes = await workflowGenerator(
      ctx(dir),
      control("ci.pr-linux-only"),
    );
    expect(changes).toEqual([
      expect.objectContaining({
        type: "note",
        message: expect.stringContaining(
          "`ci` (required: move it to a Linux runner), `installer`",
        ),
      }),
    ]);
    await applyChanges(dir, changes, { mode: "write" });
    expect(await readFile(join(dir, WF), "utf8")).toBe(workflow);
  });

  it("fails, and fixes the rest with a note, when a workflow doesn't parse", async () => {
    const broken =
      "on: [pull_request]\njobs:\n\tbuild:\n\t\truns-on: ubuntu-latest\n";
    const dir = await repoWith({
      [WF]: SHAPED,
      ".github/workflows/broken.yml": broken,
      ".github/workflows/empty.yml": "",
    });
    const [result] = await evaluateControls(
      [control("ci.job-timeouts")],
      ctx(dir),
      { profile: null, waivers: [] },
    );
    // The check can't vouch for files it couldn't read.
    expect(result?.status).toBe("fail");
    expect(result?.detectors[0]?.message).toContain(
      "couldn't parse .github/workflows/broken.yml",
    );
    const changes = await workflowGenerator(
      ctx(dir),
      control("ci.job-timeouts"),
    );
    expect(changes[0]).toMatchObject({
      type: "note",
      message: expect.stringContaining("fix these by hand"),
    });
    expect((changes[0] as { message: string }).message).toContain(
      ".github/workflows/empty.yml",
    );
  });

  it("adds a secret scan that needs no license", async () => {
    const dir = await repoWith({ [WF]: LEGACY });
    await fix(dir, "ci.secret-scan-on-pr");
    const text = await readFile(join(dir, WF), "utf8");
    expect(text).toContain("trufflesecurity/trufflehog@");
    expect(text).not.toContain("gitleaks");
  });

  it("notes a visibility it couldn't read instead of doing nothing", async () => {
    server.use(http.get(REPO, () => new HttpResponse(null, { status: 403 })));
    const dir = await repoWith({ [WF]: LEGACY });
    const changes = await workflowGenerator(
      ctx(dir),
      control("ci.pr-linux-only"),
    );
    expect(changes).toEqual([
      expect.objectContaining({
        type: "note",
        message: expect.stringContaining(
          "couldn't read whether the repo is private",
        ),
      }),
    ]);
  });

  it("doesn't count a reusable-workflow job as missing a timeout", async () => {
    const dir = await repoWith({
      [WF]: `on: [push]
jobs:
  call:
    uses: o/r/.github/workflows/shared.yml@main
`,
    });
    expect(await statusOf(dir, "ci.job-timeouts")).toBe("pass");
  });

  it("notes the fix needs a PR workflow when there is none", async () => {
    const dir = await repoWith({});
    const changes = await workflowGenerator(
      ctx(dir),
      control("ci.required-aggregator"),
    );
    expect(changes).toEqual([expect.objectContaining({ type: "note" })]);
  });
});

describe("pinActions", () => {
  it("pins tags and reports what it couldn't resolve", async () => {
    const doc = parseDocument(`jobs:
  a:
    steps:
      - uses: actions/checkout@v4
      - uses: ./local
      - uses: github/codeql-action/init@v3
      - uses: nobody/missing@v1
      - uses: limited/action@v2
  b:
    uses: o/r/.github/workflows/x.yml@main
`);
    const { changed, unresolved } = await pinActions(
      doc,
      async (_o, _r, ref) => {
        if (ref === "v2") throw new Error("API rate limit exceeded");
        return ref === "v1" ? null : SHA;
      },
    );
    expect(changed).toBe(true);
    expect(unresolved).toEqual([
      "nobody/missing@v1 (no such ref)",
      "limited/action@v2 (API rate limit exceeded)",
    ]);
    const text = doc.toString();
    expect(text).toContain(`actions/checkout@${SHA} # v4`);
    expect(text).toContain(`github/codeql-action/init@${SHA} # v3`);
    expect(text).toContain(`o/r/.github/workflows/x.yml@${SHA} # main`);
    expect(text).toContain("uses: ./local");
  });
});
