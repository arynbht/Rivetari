import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { closeApp, launchApp, type LaunchedApp, runAxe } from "./helpers";
import { emptyRepo, nowRepo, WHO } from "./now-fixture";
import { LEDGER_KEY } from "./tasks-fixture";

// The Now view against a repo with a task at each kind of wait and one
// running: every item renders with what the person needs to decide, confirm,
// approve and answer go through the runtime and land in the ledger and on the
// tasks branch, a stop asked while the app is open raises a notification (read
// through the E2E seam, which shows none on the desktop) and a badge, and axe
// finds nothing serious. Screenshots go to RIVETARI_SHOTS_DIR when it's set.

const shotsDir = process.env.RIVETARI_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  const testInfo = test.info();
  const path = shotsDir
    ? join(shotsDir, `${name}.png`)
    : testInfo.outputPath(`${name}.png`);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

function lastEntry(repo: string, id: string): { text: string; by: string } {
  const lines = readFileSync(
    join(repo, ".rivetari", "tasks", id, "ledger.jsonl"),
    "utf8",
  )
    .trim()
    .split("\n");
  return JSON.parse(lines.at(-1) ?? "{}") as { text: string; by: string };
}

const onBranch = (repo: string, id: string) =>
  execFileSync("git", ["show", `rivetari/tasks:${id}/ledger.jsonl`], {
    cwd: repo,
    encoding: "utf8",
  });

type Notices = { repoPath: string; id: string; title: string }[];
const notices = (launched: LaunchedApp) =>
  launched.app.evaluate(
    () =>
      (globalThis as unknown as { rivetariE2E: { notices: Notices } })
        .rivetariE2E.notices,
  );

async function openNow(page: Page, name: string) {
  await page
    .getByRole("button", { name: new RegExp(name) })
    .first()
    .click();
  await page.getByRole("tab", { name: "Now" }).click();
  const panel = page.locator("#panel-now");
  await expect(
    panel.getByRole("heading", { name: "Now", exact: true }),
  ).toBeVisible();
  return panel;
}

test.describe("now", () => {
  let launched: LaunchedApp | undefined;
  const cleanup: string[] = [];

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
    launched = undefined;
    for (const dir of cleanup.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  async function launch(repo: string, name: string) {
    // A private config dir: no sign-in, and no ledger key but the fixture's.
    const config = mkdtempSync(join(tmpdir(), "rivetari-e2e-config-"));
    cleanup.push(repo, config);
    launched = await launchApp({
      repos: [{ path: repo, name }],
      env: { RIVETARI_LEDGER_KEY: LEDGER_KEY, RIVETARI_CONFIG_DIR: config },
    });
    return launched;
  }

  test("shows each kind of wait, what's running, the feed and the health strip", async () => {
    const { repo } = nowRepo();
    const { page } = await launch(repo, "now-repo");

    // Before the Now tab opens, the sidebar already counts what waits.
    await expect(
      page.getByRole("button", { name: /now-repo/ }).first(),
    ).toContainText("5 waiting on you");
    const panel = await openNow(page, "now-repo");

    const needsYou = panel.getByRole("region", { name: /Needs you/ });
    const item = (id: string) =>
      needsYou.getByRole("article", { name: new RegExp(id) });
    await expect(needsYou.getByRole("article")).toHaveCount(5);

    const intake = item("T-0001");
    await expect(intake).toContainText("Card to confirm");
    await expect(intake).toContainText(
      "Add a dark mode toggle, so readers can choose.",
    );
    await expect(intake).toContainText("A1 A toggle switches the theme");
    await expect(intake).toContainText("A2 The choice is kept across launches");
    await expect(intake).toContainText("print styles");
    await expect(intake.getByRole("button", { name: "Confirm" })).toBeEnabled();

    const route = item("T-0002");
    await expect(route).toContainText("Route to approve");
    for (const text of [
      "Sectorsui",
      "Checksquality.lint.clean",
      "Proofui-screenshots",
      "Gapsno vendored skill covers motion",
      "0 skill tokens · 4,000 context tokens · 30 steps",
      "routed to ui: ui (path src/settings/**)",
    ])
      await expect(route).toContainText(text);
    await expect(route.getByRole("button", { name: "Approve" })).toBeEnabled();

    const stop = item("T-0003");
    await expect(stop).toContainText("Stop-and-ask");
    await expect(
      stop.getByRole("form", { name: "Answer the stop" }),
    ).toContainText("dependency: adds @radix-ui/react-switch");

    const judge = item("T-0004");
    await expect(judge).toContainText("Judge wants a person");
    await expect(judge).toContainText("Round 1: needs a human");
    await expect(judge).toContainText(
      "Turns off a lint rule CONSTRAINTS.md requires",
    );
    await expect(judge).toContainText("eslint.config.js: lint config changed");
    await expect(judge).toContainText("A1 unverified — no e2e ran");
    await expect(judge).toContainText("Next: stop-and-ask");

    const merge = item("T-0005");
    await expect(merge).toContainText("PR waiting to merge");
    await expect(merge.getByRole("link", { name: "PR #42" })).toBeVisible();
    await expect(merge).toContainText("Next: close: once the PR is merged");

    const running = panel.getByRole("region", { name: "Running" });
    await expect(running.getByRole("listitem")).toHaveCount(1);
    await expect(running).toContainText("T-0006");
    await expect(running).toContainText(
      "build · last tool Edit · turn 18 · 12 min",
    );

    const recent = panel.getByRole("region", { name: "Recent" });
    const feed = recent.getByRole("button");
    // Newest first: T-0005 shipped last of all.
    await expect(feed.first()).toContainText("shipped");
    await expect(feed.first()).toContainText("T-0005");
    await expect(recent).toContainText("merged");
    await expect(recent).toContainText("PR #40 merged by ann@example.com");

    const health = panel.getByRole("region", { name: "Health" });
    await expect(health).toContainText("supervised (configured)");
    await expect(health).toContainText(
      "effective level: run rivetari autonomy",
    );
    await expect(health).toContainText("$0.00 today");
    await expect(health).toContainText("on open tasks");
    await expect(health).toContainText("0 locked · 0 installed · 1 gap");
    await expect(health).toContainText("sign in to see CI");

    await shot(page, "now-after");
    expect(await runAxe(page), "now view").toEqual([]);

    // A feed row opens its task in the Tasks tab.
    await recent
      .getByRole("button", { name: /T-0007/ })
      .first()
      .click();
    await expect(page.getByRole("tab", { name: "Tasks" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.locator("#panel-tasks").getByRole("region", { name: /T-0007/ }),
    ).toBeVisible();
  });

  test("confirm, approve and answer go through the runtime and land in the ledger", async () => {
    const { repo } = nowRepo();
    const { page } = await launch(repo, "now-repo");
    const panel = await openNow(page, "now-repo");
    const needsYou = panel.getByRole("region", { name: /Needs you/ });
    const item = (id: string) =>
      needsYou.getByRole("article", { name: new RegExp(id) });

    await item("T-0001").getByRole("button", { name: "Confirm" }).click();
    await expect(item("T-0001")).toHaveCount(0);
    expect(lastEntry(repo, "T-0001")).toMatchObject({
      text: expect.stringMatching(
        /^intake confirmed; card sha256 [0-9a-f]{64}$/,
      ),
      by: WHO,
    });
    expect(onBranch(repo, "T-0001")).toContain("intake confirmed");

    await item("T-0002").getByRole("button", { name: "Approve" }).click();
    await expect(item("T-0002")).toHaveCount(0);
    expect(lastEntry(repo, "T-0002")).toMatchObject({
      text: expect.stringMatching(
        /^route approved; assembly sha256 [0-9a-f]{64}$/,
      ),
      by: WHO,
    });
    expect(onBranch(repo, "T-0002")).toContain("route approved");

    const stop = item("T-0003");
    await stop.getByLabel(/Note/).fill("use a native checkbox instead");
    await stop.getByRole("button", { name: "Deny" }).click();
    await expect(item("T-0003")).toHaveCount(0);
    expect(lastEntry(repo, "T-0003")).toMatchObject({
      text: "answered: denied — use a native checkbox instead",
      by: WHO,
    });
    expect(onBranch(repo, "T-0003")).toContain("answered: denied");

    await expect(needsYou.getByRole("article")).toHaveCount(2);
    await expect(
      page.getByRole("button", { name: /now-repo/ }).first(),
    ).toContainText("2 waiting on you");
    await expect(panel.getByRole("region", { name: "Recent" })).toContainText(
      "answered: denied — use a native checkbox instead",
    );
    expect(await runAxe(page), "after the actions").toEqual([]);
  });

  test("a stop asked while the app is open raises a notification, a badge, and opens on its item", async () => {
    const fixture = nowRepo();
    const app = await launch(fixture.repo, "now-repo");
    const { page } = app;
    const panel = await openNow(page, "now-repo");
    const needsYou = panel.getByRole("region", { name: /Needs you/ });
    await expect(needsYou.getByRole("article")).toHaveCount(5);
    // What was waiting at launch isn't news.
    expect(await notices(app)).toEqual([]);

    await page.getByRole("tab", { name: "Scorecard" }).click();
    fixture.running.append(
      ["build", "stop", "asked: schema: adds a theme column"],
      new Date().toISOString(),
    );
    await expect
      .poll(async () => (await notices(app)).map((n) => n.title))
      .toEqual(["T-0006 needs you: answer a stop"]);
    await expect(
      page.getByRole("button", { name: /now-repo/ }).first(),
    ).toContainText("6 waiting on you");

    // Clicking it brings the app back to Now, on that item.
    await app.app.evaluate(() =>
      (
        globalThis as unknown as { rivetariE2E: { click: (i: number) => void } }
      ).rivetariE2E.click(0),
    );
    await expect(page.getByRole("tab", { name: "Now" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      needsYou.getByRole("article", { name: /T-0006/ }),
    ).toBeFocused();
    await shot(page, "now-notified");
    expect(await notices(app)).toHaveLength(1);
  });

  test("a repo with no tasks says how to start one", async () => {
    const repo = emptyRepo();
    const { page } = await launch(repo, "empty-repo");
    const panel = await openNow(page, "empty-repo");
    await expect(panel).toContainText(
      "No tasks in this repository yet. Start one with /rivetari <ask> in Claude Code, or rivetari task new.",
    );
    await expect(panel.getByRole("region", { name: "Health" })).toContainText(
      "no profile to read a level from",
    );
    await shot(page, "now-empty");
    expect(await runAxe(page), "empty now view").toEqual([]);
  });
});
