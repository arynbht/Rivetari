// proof.auth on real repos: the profile's sign-in script runs once the app
// answers, every shot on both sides loads the signed-in state, and a script
// that fails or doesn't sign in fails the proof saying so rather than shooting
// the login page.
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
import { confirmTask, newTask, nextStep } from "../task/tasks.js";
import { proveTask } from "./prove.js";
import { browserAvailable } from "./shoot.js";

const made: string[] = [];
const tmp = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
};
const savedConfig = process.env.RIVETARI_CONFIG_DIR;
const by = { by: "dev@example.com", now: new Date("2026-11-10T18:00:00Z") };
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
  const repo = await tmp("rivetari-auth-repo-");
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

async function built(
  repo: string,
  edit: (cwd: string) => Promise<void>,
): Promise<string> {
  const draft = await newTask(
    repo,
    {
      title: "Redesign the dashboard page",
      type: "feature",
      description: "Redesign the dashboard page",
      acceptance: [{ id: "A1", text: "It works", verify: "e2e" }],
    },
    by,
  );
  const id = draft.card.id;
  await confirmTask(repo, id, by);
  await routeTask(repo, id, { ...by, context });
  await approveRoute(repo, id, { ...by, context });
  await isolateTask(repo, id, { ...by, base: "main" });
  const agent = async (call: AgentCall) => {
    if (call.mode === "plan") return JSON.stringify({ steps: ["do it"] });
    await edit(call.cwd);
    return "done";
  };
  const outcome = await buildTask(repo, id, { ...by, agent });
  expect(outcome.stops).toEqual([]);
  return id;
}

const page = (body: string) =>
  `<!doctype html><html lang="en"><head><title>Demo</title></head><body><main>${body}</main></body></html>`;

/**
 * An app behind sign-in: "/" answers 401 without the session cookie, and the
 * login form's POST sets it (unless `setsCookie` is false, a broken sign-in).
 */
const app = (heading: string, setsCookie = true) => `
const http = require("http");
const html = (s, code, body) => { s.statusCode = code; s.setHeader("content-type", "text/html"); s.end(body); };
http.createServer((q, s) => {
  if (q.url === "/login" && q.method === "POST") {
    ${setsCookie ? 's.setHeader("set-cookie", "session=ok; Path=/; HttpOnly");' : ""}
    s.statusCode = 303; s.setHeader("location", "/"); return s.end();
  }
  if (q.url === "/login") return html(s, 200, ${JSON.stringify(page('<h1>Sign in</h1><form method="post" action="/login"><button>Sign in</button></form>'))});
  if (!/session=ok/.test(q.headers.cookie ?? "")) return html(s, 401, ${JSON.stringify(page("<h1>Sign in first</h1>"))});
  html(s, 200, ${JSON.stringify(page(`<h1>${heading}</h1>`))});
}).listen(process.env.PORT);
`;

/** The sign-in script: checks what it's given, then signs in through the form. */
const SIGN_IN = `export default async ({ page, context, baseURL }) => {
  if (process.env.URL !== baseURL || !baseURL.includes(":" + process.env.PORT)) throw new Error("no PORT/URL");
  if (!context) throw new Error("no context");
  await page.goto("/login");
  await page.click("button");
  await page.waitForURL(baseURL.replace(/\\/?$/, "/"));
};
`;

const BASE = {
  "package.json": `${JSON.stringify({ name: "demo" }, null, 2)}\n`,
  "server.js": app("Dashboard"),
  ".rivetari/proof-auth.mjs": SIGN_IN,
  ".rivetari/profile.yml":
    "version: 1\nname: demo\ntype: web-app\nproof:\n  start: node server.js\n  auth:\n    script: .rivetari/proof-auth.mjs\n",
};

const stateDirs = async () =>
  (await readdir(tmpdir())).filter((d) => d.startsWith("rivetari-proof-auth-"));

const hasBrowser = await browserAvailable();

describe.skipIf(!hasBrowser)(
  "UI proof with proof.auth",
  { timeout: 180_000 },
  () => {
    it("signs in once the app answers and shoots every page, before and after, signed in", async () => {
      const repo = await repoWith(BASE);
      const id = await built(repo, (cwd) =>
        writeFile(join(cwd, "server.js"), app("Dashboard, rebuilt")),
      );
      const leftBefore = await stateDirs();
      const { task, record } = await proveTask(repo, id, {
        ...by,
        publish: async () => null,
      });
      expect(record.lines).toContain(
        "signed in: .rivetari/proof-auth.mjs ran on each side before its shots",
      );
      // Signed out, "/" answers 401: every shot answering 200 is every shot signed in.
      expect(
        record.shots?.map((s) => `${s.side}-${s.breakpoint}-${s.status}`),
      ).toEqual([
        "before-sm-200",
        "before-md-200",
        "before-lg-200",
        "after-sm-200",
        "after-md-200",
        "after-lg-200",
      ]);
      expect(record.passed).toBe(true);
      expect(nextStep(task)).toBe("judge");
      // The signed-in state doesn't outlive the proof.
      expect(await stateDirs()).toEqual(leftBefore);
    });

    it("a change whose sign-in leaves no session fails the proof, told why", async () => {
      const repo = await repoWith(BASE);
      const id = await built(repo, (cwd) =>
        writeFile(join(cwd, "server.js"), app("Dashboard", false)),
      );
      const { task, record } = await proveTask(repo, id, {
        ...by,
        publish: async () => null,
      });
      expect(record.passed).toBe(false);
      expect(record.lines[0]).toMatch(
        /^the change served, but signing in failed: the auth script \.rivetari\/proof-auth\.mjs finished but left no cookies or local storage: it didn't sign in/,
      );
      // Only the base's shots: nothing was shot on the change signed out.
      expect(record.shots?.every((s) => s.side === "before")).toBe(true);
      expect(nextStep(task)).toMatch(/^build: .*the proof failed/);
    });

    it("a sign-in script that throws on the base stops the proof as a setup problem", async () => {
      const repo = await repoWith({
        ...BASE,
        ".rivetari/proof-auth.mjs":
          'export default async () => { throw new Error("demo account missing"); };\n',
      });
      const id = await built(repo, (cwd) =>
        writeFile(join(cwd, "server.js"), app("Dashboard, rebuilt")),
      );
      await expect(
        proveTask(repo, id, { ...by, publish: async () => null }),
      ).rejects.toThrow(
        /^signing in on the base failed, so proof\.auth in \.rivetari\/profile\.yml needs fixing: the auth script \.rivetari\/proof-auth\.mjs failed \(exit 1\): .*demo account missing/,
      );
    });

    it("a script that exports no function fails clearly", async () => {
      const repo = await repoWith({
        ...BASE,
        ".rivetari/proof-auth.mjs": "export const signIn = 1;\n",
      });
      const id = await built(repo, (cwd) =>
        writeFile(join(cwd, "server.js"), app("Dashboard, rebuilt")),
      );
      await expect(
        proveTask(repo, id, { ...by, publish: async () => null }),
      ).rejects.toThrow(/must export a default function/);
    });
  },
);
