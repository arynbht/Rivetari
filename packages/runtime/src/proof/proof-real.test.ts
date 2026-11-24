// The prove beat proves the real page: it waits out a loading skeleton and
// shoots the data, fails when the data never comes, shoots and runs axe at
// the profile's widths with the base's own violations called pre-existing,
// reuses the base's images, skips screenshots for a change that can't render,
// and runs (or honestly doesn't run) the infra-plan proof's container check.
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

import { loadManifests } from "@arynbht/rivetari-registry";
import { simpleGit } from "simple-git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type AgentCall, buildTask } from "../agent/build.js";
import { isolateTask } from "../agent/isolate.js";
import {
  approveRoute,
  type RouteContext,
  routeTask,
} from "../router/task-route.js";
import { confirmTask, loadTask, newTask, nextStep } from "../task/tasks.js";
import { DEFERRED, proveTask } from "./prove.js";
import { browserAvailable } from "./shoot.js";

const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-24T18:00:00Z") };
let context: RouteContext;

beforeEach(async () => {
  process.env.RIVETARI_CONFIG_DIR = await tmp("rivetari-config-");
});
afterEach(async () => {
  if (savedConfig === undefined) delete process.env.RIVETARI_CONFIG_DIR;
  else process.env.RIVETARI_CONFIG_DIR = savedConfig;
  for (const d of made) {
    await simpleGit(d)
      .raw(["worktree", "prune"])
      .catch(() => undefined);
    await rm(d, { recursive: true, force: true });
  }
  made.length = 0;
});

async function repoWith(files: Record<string, string>): Promise<string> {
  const repo = await tmp("rivetari-proof-real-");
  const git = simpleGit(repo);
  await git.init(["-b", "main"]);
  await git.addConfig("user.email", "t@t");
  await git.addConfig("user.name", "t");
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(repo, path, ".."), { recursive: true });
    await writeFile(join(repo, path), text);
  }
  await git.add(["-A"]);
  await git.commit("base", ["--no-verify"]);
  const { manifests } = await loadManifests(repo);
  context = {
    manifests,
    available: new Set(),
    flags: {},
    files: Object.keys(files),
    checks: ["quality.tests.pass"],
  };
  return repo;
}

const agentEditing =
  (edit: (cwd: string) => Promise<void>) => async (call: AgentCall) => {
    if (call.mode === "plan") return JSON.stringify({ steps: ["do it"] });
    await edit(call.cwd);
    return "done";
  };

/** Route, approve, isolate and build a task with a scripted edit. */
async function built(
  repo: string,
  title: string,
  edit: (cwd: string) => Promise<void>,
): Promise<string> {
  const draft = await newTask(
    repo,
    {
      title,
      type: "feature",
      description: title,
      acceptance: [{ id: "A1", text: "It works", verify: "e2e" }],
    },
    by,
  );
  const id = draft.card.id;
  await confirmTask(repo, id, by);
  await routeTask(repo, id, { ...by, context });
  await approveRoute(repo, id, { ...by, context });
  await isolateTask(repo, id, { ...by, base: "main" });
  const outcome = await buildTask(repo, id, {
    ...by,
    agent: agentEditing(edit),
  });
  expect(outcome.stops).toEqual([]);
  return id;
}

const UI_TITLE = "Redesign the settings page";
const head =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Demo</title>';
const page = (body: string, extra = "") =>
  `${head}${extra}</head><body><main>${body}</main></body></html>`;
/** An app that serves `html` at every path, and `/api/data` after `delayMs`. */
const server = (html: string, delayMs = 0) =>
  `require("http").createServer((q, s) => {
  if (q.url === "/api/data") return setTimeout(() => { s.setHeader("content-type", "application/json"); s.end(JSON.stringify({ rows: [["Alex Morgan", 7], ["Leo Brandt", 5]] })); }, ${delayMs});
  s.setHeader("content-type", "text/html"); s.end(${JSON.stringify(html)});
}).listen(process.env.PORT);\n`;
/** A page that shows a skeleton, fetches its data, and renders it. */
const SKELETON_THEN_DATA = page(
  `<h1>Sessions</h1><div class="skeleton" aria-busy="true" style="height:200px;background:#eee"></div>
<script>fetch("/api/data").then((r) => r.json()).then((d) => {
  document.querySelector(".skeleton").outerHTML = '<table id="data">' + d.rows.map((r) => "<tr><td>" + r[0] + "</td><td>" + r[1] + "</td></tr>").join("") + "</table>";
});</script>`,
);
/** A page stuck on its skeleton: the data never comes. */
const SKELETON_FOREVER = page(
  '<h1>Sessions</h1><div class="skeleton" aria-busy="true" style="height:200px;background:#eee"></div>',
);
const profile = (extra = "") =>
  `version: 1\nname: demo\ntype: web-app\nproof:\n  start: node server.js\n${extra}`;
const BASE = {
  "package.json": `${JSON.stringify({ name: "demo", scripts: { test: "node -e 0" } }, null, 2)}\n`,
  "server.js": server(page("<h1>Sessions</h1><p>No sessions yet.</p>")),
  ".rivetari/profile.yml": profile("  render_timeout: 3\n"),
};
const noPublish = { ...by, publish: async () => null };

const hasBrowser = await browserAvailable();

describe.skipIf(!hasBrowser)(
  "UI proof of the real page",
  { timeout: 240_000 },
  () => {
    it("waits out the skeleton and shoots the data that arrives after it", async () => {
      const repo = await repoWith(BASE);
      const id = await built(repo, UI_TITLE, (cwd) =>
        writeFile(join(cwd, "server.js"), server(SKELETON_THEN_DATA, 1500)),
      );
      const { task, record } = await proveTask(repo, id, noPublish);
      const after = record.shots?.filter((s) => s.side === "after") ?? [];
      expect(after.map((s) => s.breakpoint)).toEqual(["sm", "md", "lg"]);
      for (const shot of after) {
        expect(shot.ready).toBe(true);
        expect(shot.layout?.text).toContain("Alex Morgan");
        expect(shot.bytes).toBeGreaterThan(0);
      }
      expect(record.passed).toBe(true);
      expect(record.lines).toContain(
        "rendered: each shot waited for network idle, no loading marker and a settled DOM",
      );
      expect(record.lines.find((l) => l.startsWith("image sizes"))).toMatch(
        /^image sizes in bytes, before → after: \/ sm \d+ → \d+, md \d+ → \d+, lg \d+ → \d+$/,
      );
      expect(nextStep(task)).toBe("judge");
    });

    it("fails, told why, when the data never arrives, and doesn't grade the skeleton with axe", async () => {
      const repo = await repoWith(BASE);
      const id = await built(repo, UI_TITLE, (cwd) =>
        writeFile(join(cwd, "server.js"), server(SKELETON_FOREVER)),
      );
      const { task, record } = await proveTask(repo, id, noPublish);
      expect(record.passed).toBe(false);
      expect(
        record.shots?.filter((s) => s.side === "after" && s.ready === false),
      ).toHaveLength(3);
      expect(record.lines).toContainEqual(
        expect.stringMatching(
          /^not rendered, so these shots are of the loading state and the proof fails: \/ at sm: still showing a loading state after 3s: div\.skeleton\[aria-busy="true"\]/,
        ),
      );
      expect(nextStep(task)).toMatch(/^build: .*the proof failed/);
      const proofJson = JSON.parse(
        await readFile(
          join(repo, ".rivetari/tasks", id, "proof/proof.json"),
          "utf8",
        ),
      ) as { shots: { notReady?: string }[] };
      expect(
        proofJson.shots.some((s) => s.notReady?.includes("loading state")),
      ).toBe(true);
    });

    it("waits for a named ready selector, and fails when it never shows", async () => {
      // Data that lands 1.2s after load with no loading marker: settling alone
      // would shoot the empty page, which is why a repo can name what to wait for.
      const late = (rows: boolean) =>
        page(
          `<h1>Trends</h1><div id="chart"></div>${
            rows
              ? `<script>setTimeout(() => { document.getElementById("chart").innerHTML = '<p id="data">Alex Morgan 7</p>'; }, 1200);</script>`
              : ""
          }`,
        );
      const files = {
        ...BASE,
        ".rivetari/profile.yml": profile(
          '  render_timeout: 2\n  ready:\n    "/": "#data"\n',
        ),
      };
      const repo = await repoWith(files);
      const id = await built(repo, UI_TITLE, (cwd) =>
        writeFile(join(cwd, "server.js"), server(late(true))),
      );
      const { record } = await proveTask(repo, id, noPublish);
      expect(record.passed).toBe(true);
      for (const shot of record.shots?.filter((s) => s.side === "after") ?? [])
        expect(shot.layout?.text).toContain("Alex Morgan 7");
      expect(record.lines).toContain(
        'rendered: each shot waited for "#data" (proof.ready)',
      );
      // The base has no #data: its shots are noted, not a failure of the change.
      expect(record.lines).toContainEqual(
        expect.stringMatching(
          /^before: never rendered on the base, \/ at sm: the ready selector "#data" never showed within 2s/,
        ),
      );

      const repo2 = await repoWith(files);
      const id2 = await built(repo2, UI_TITLE, (cwd) =>
        writeFile(join(cwd, "server.js"), server(late(false))),
      );
      const failed = await proveTask(repo2, id2, noPublish);
      expect(failed.record.passed).toBe(false);
      expect(failed.record.lines).toContainEqual(
        expect.stringContaining(
          '/ at sm: the ready selector "#data" never showed within 2s',
        ),
      );
    });

    it("shoots and runs axe at the profile's widths, and calls the base's own violations pre-existing", async () => {
      // The base already lacks alt text; the change adds a nameless button
      // that only shows below 600px.
      const narrowOnly =
        "<style>@media (min-width: 600px) { .narrow { display: none } }</style>";
      const repo = await repoWith({
        ...BASE,
        "server.js": server(page('<h1>Sessions</h1><img src="/x.png">')),
        ".rivetari/profile.yml": profile(
          "  render_timeout: 3\n  widths: [400, 1024]\n",
        ),
      });
      const id = await built(repo, UI_TITLE, (cwd) =>
        writeFile(
          join(cwd, "server.js"),
          server(
            page(
              '<h1>Sessions</h1><img src="/x.png"><button class="narrow"></button>',
              narrowOnly,
            ),
          ),
        ),
      );
      const { record } = await proveTask(repo, id, noPublish);
      expect(record.shots?.map((s) => `${s.side}-${s.breakpoint}`)).toEqual([
        "before-w400",
        "before-w1024",
        "after-w400",
        "after-w1024",
      ]);
      expect(record.passed).toBe(false);
      expect(record.lines[0]).toMatch(
        /^screenshots: \/ at w400\/w1024 \(400\/1024px\), before and after, axe at every width \(4 images\)/,
      );
      expect(record.lines[1]).toBe(
        "axe: 1 serious or critical violation(s): button-name on / (critical, 1) at w400; pre-existing on the base too, not blamed on this change: image-alt on / (critical, 1) at w400/w1024",
      );
      expect(record.violations?.map((v) => `${v.id}@${v.breakpoint}`)).toEqual([
        "button-name@w400",
      ]);
    });

    it("reuses the base's images on the next round, and passes a change that only keeps the base's violations", async () => {
      const repo = await repoWith({
        ...BASE,
        "server.js": server(page('<h1>Sessions</h1><img src="/x.png">')),
      });
      const id = await built(repo, UI_TITLE, (cwd) =>
        writeFile(join(cwd, "server.js"), server(SKELETON_FOREVER)),
      );
      const first = await proveTask(repo, id, noPublish);
      expect(first.record.passed).toBe(false);
      expect(
        first.record.lines.some((l) => l.startsWith("before: reused")),
      ).toBe(false);

      await buildTask(repo, id, {
        ...by,
        agent: agentEditing((cwd) =>
          writeFile(
            join(cwd, "server.js"),
            server(page('<h1>Sessions</h1><img src="/x.png"><p>Rebuilt.</p>')),
          ),
        ),
      });
      expect(nextStep(await loadTask(repo, id))).toBe("prove");
      const second = await proveTask(repo, id, noPublish);
      expect(second.record.lines).toContain(
        "before: reused this base tree's images from an earlier proof at the same widths and pages",
      );
      const before =
        second.record.shots?.filter((s) => s.side === "before") ?? [];
      expect(before).toHaveLength(3);
      for (const shot of before) await access(shot.file);
      expect(second.record.passed).toBe(true);
      expect(second.record.lines[1]).toBe(
        "axe: 0 new serious or critical violations; pre-existing on the base too, not blamed on this change: image-alt on / (critical, 1) at sm/md/lg",
      );
    });

    it("flags before and after images that are byte-identical though the change touches UI files", async () => {
      const repo = await repoWith(BASE);
      const id = await built(repo, UI_TITLE, (cwd) =>
        writeFile(
          join(cwd, "server.js"),
          `// Same page, new comment.\n${BASE["server.js"]}`,
        ),
      );
      const { record } = await proveTask(repo, id, noPublish);
      expect(record.lines).toContain(
        "unchanged: the before and after images are byte-identical for / at sm, / at md, / at lg, though the change touches UI files: either these pages don't show it, or the shots aren't of the change",
      );
    });
  },
);

describe(
  "a UI proof for a change that can't render",
  { timeout: 120_000 },
  () => {
    it("skips the screenshots, and the test run stands in", async () => {
      const repo = await repoWith(BASE);
      const id = await built(repo, UI_TITLE, (cwd) =>
        writeFile(
          join(cwd, "README.md"),
          "# Demo\n\nHow the settings page works.\n",
        ),
      );
      const { task, record } = await proveTask(repo, id, noPublish);
      expect(record.kind).toBe("test-run");
      expect(record.shots).toBeUndefined();
      expect(record.lines[0]).toBe(
        "ui-screenshots skipped: the change touches no file that renders (README.md), so the test run stands in",
      );
      expect(record.lines[1]).toMatch(/^tests passed/);
      expect(record.passed).toBe(true);
      expect(nextStep(task)).toBe("judge");
    });

    it("defers to the judge's test run when asked, saying why", async () => {
      const repo = await repoWith(BASE);
      const id = await built(repo, UI_TITLE, (cwd) =>
        writeFile(join(cwd, "PLAN.md"), "# Plan\n"),
      );
      const { task } = await proveTask(repo, id, {
        ...noPublish,
        deferTestRun: true,
      });
      const ledger = await readFile(task.ledger.mdPath, "utf8");
      expect(ledger).toContain(
        "ui-screenshots skipped: the change touches no file that renders (PLAN.md), so the test run stands in",
      );
      expect(ledger).toContain(DEFERRED);
      expect(nextStep(task)).toBe("judge");
    });
  },
);

describe("infra-plan proof", { timeout: 120_000 }, () => {
  const INFRA_TITLE = "Add a Dockerfile to deploy the app";
  const INFRA_BASE = {
    "package.json": `${JSON.stringify({ name: "demo", scripts: { test: "node -e 0" } }, null, 2)}\n`,
    "server.js":
      'require("http").createServer((q, s) => s.end("ok")).listen(8080);\n',
  };
  const addDockerfile = (cwd: string) =>
    writeFile(
      join(cwd, "Dockerfile"),
      'FROM node:22-alpine\nCOPY . .\nCMD ["node", "server.js"]\n',
    );

  it("with no docker, says the container check didn't run: unverified, never passed", async () => {
    const repo = await repoWith({
      ...INFRA_BASE,
      ".rivetari/profile.yml":
        "version: 1\nname: demo\ntype: web-app\nproof:\n  docker:\n    port: 8080\n",
    });
    const id = await built(repo, INFRA_TITLE, addDockerfile);
    const { task, record } = await proveTask(repo, id, {
      ...noPublish,
      docker: join(repo, "no-such-docker"),
    });
    expect(record.kind).toBe("infra-plan");
    expect(record.unverified).toEqual(["docker"]);
    expect(record.lines[0]).toBe(
      "infra-plan: the test run, then the container built, run and checked over HTTP (proof.docker)",
    );
    expect(record.lines).toContain(
      "docker: not run: docker unavailable; unverified, a person attaches the infra-plan proof",
    );
    const ledger = await readFile(task.ledger.mdPath, "utf8");
    expect(ledger).toContain("proof passed · infra-plan · unverified: docker");
  });

  it("with no proof.docker, a container change is called unverified", async () => {
    const repo = await repoWith({
      ...INFRA_BASE,
      ".rivetari/profile.yml": "version: 1\nname: demo\ntype: web-app\n",
    });
    const id = await built(repo, INFRA_TITLE, addDockerfile);
    const { record } = await proveTask(repo, id, noPublish);
    expect(record.unverified).toEqual(["docker"]);
    expect(record.lines[0]).toBe(
      "infra-plan: no proof.docker in .rivetari/profile.yml, so the test run stands in, and a person attaches the infra-plan proof",
    );
    expect(record.lines).toContain(
      "docker: not run: the change touches Dockerfile, but .rivetari/profile.yml has no proof.docker to build and check it with; unverified",
    );
  });
});
