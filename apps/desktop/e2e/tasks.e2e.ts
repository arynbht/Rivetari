import { rmSync } from "node:fs";

import { expect, test } from "@playwright/test";

import { closeApp, launchApp, type LaunchedApp, runAxe } from "./helpers";
import { LEDGER_KEY, tasksRepo } from "./tasks-fixture";

// Tasks tab: the runtime's read-only task watcher over IPC, against a repo with a
// running task (holding a lease), a stopped one waiting on a person and a shipped
// one. Screenshots of the list and of a task's ledger are attached as proof, and
// axe runs on both.
test.describe("tasks", () => {
  let launched: LaunchedApp | undefined;
  let repo: string | undefined;

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test("shows the tasks, what waits on a person, and a live ledger, with nothing to act on", async () => {
    const testInfo = test.info();
    const fixture = tasksRepo();
    repo = fixture.repo;
    launched = await launchApp({
      repos: [{ path: repo, name: "tasks-repo" }],
      // The fixture's ledgers are signed with this key.
      env: { RIVETARI_LEDGER_KEY: LEDGER_KEY },
    });
    const { page } = launched;

    await page
      .getByRole("button", { name: /tasks-repo/ })
      .first()
      .click();
    await page.getByRole("tab", { name: "Tasks" }).click();
    const panel = page.locator("#panel-tasks");
    await expect(
      panel.getByRole("heading", { name: "Tasks", exact: true }),
    ).toBeVisible();
    await panel
      .getByRole("group", { name: "Show tasks as" })
      .getByRole("button", { name: "List" })
      .click();

    // The stopped task is the one waiting on a person, and says why.
    const needsYou = panel.getByRole("region", { name: "Needs you" });
    await expect(needsYou.getByRole("button")).toHaveCount(1);
    await expect(needsYou).toContainText("T-0002");
    await expect(needsYou).toContainText("Stop-and-ask");
    await expect(needsYou).toContainText(
      "dependency: adds @radix-ui/react-switch",
    );

    const rows = panel
      .getByRole("region", { name: "All tasks" })
      .locator("tbody tr");
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText("T-0001");
    await expect(rows.nth(0)).toContainText("build");
    await expect(rows.nth(0)).toContainText("ann@example.com on build-box");
    await expect(rows.nth(1)).toContainText("build 1 · judge 0");
    await expect(rows.nth(2)).toContainText("ship");
    await expect(rows.nth(2)).toContainText("build 1 · judge 1");
    await expect(rows.nth(2)).toContainText("$0.20");

    // Read-only: nothing in the tab runs, approves, answers or closes a task.
    await expect(
      panel.getByRole("button", {
        name: /\b(run|approve|answer|close|confirm|release|allow|deny)\b/i,
      }),
    ).toHaveCount(0);

    await page.screenshot({ path: testInfo.outputPath("tasks-list.png") });
    await testInfo.attach("tasks-list", {
      path: testInfo.outputPath("tasks-list.png"),
      contentType: "image/png",
    });
    expect(await runAxe(page), "tasks list").toEqual([]);

    // The shipped task links its PR.
    await rows.nth(2).getByRole("button").click();
    const detail = panel.getByRole("region", { name: /T-0003/ });
    await expect(detail).toContainText("Fix the update banner contrast");
    await expect(detail.getByRole("link", { name: "PR #42" })).toHaveAttribute(
      "href",
      "https://github.com/arynbht/example/pull/42",
    );

    // The running task's ledger follows new entries as the runtime writes them.
    await rows.nth(0).getByRole("button").click();
    const ledger = panel.getByRole("list", { name: "T-0001 ledger" });
    await expect(ledger).toContainText("build started");
    fixture.running.append([
      "build",
      "timeline",
      "build done · commit def5678 · 1 file(s) this round · 300 tokens · $0.03",
    ]);
    await expect(ledger).toContainText("build done · commit def5678");
    await expect(rows.nth(0)).toContainText("build 1 · judge 0");

    await ledger.locator("li").last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("tasks-ledger.png") });
    await testInfo.attach("tasks-ledger", {
      path: testInfo.outputPath("tasks-ledger.png"),
      contentType: "image/png",
    });
    expect(await runAxe(page), "task ledger").toEqual([]);
  });
});
