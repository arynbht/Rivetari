import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { closeApp, launchApp, type LaunchedApp, runAxe } from "./helpers";
import { historyRepo } from "./history-fixture";
import { LEDGER_KEY } from "./tasks-fixture";

// The History tab over two sealed tasks: the spend summary, the cost trend
// (as a chart and as a table), the judge's findings with a candidate rule,
// the cost flags and the closed tasks all read from history.jsonl and the
// ledgers. A closed task's PR opens from its ledger, a task opens its detail
// in Tasks, nothing about DORA shows, and axe finds nothing serious.
// Screenshots go to RIVETARI_SHOTS_DIR when it's set.

const shotsDir = process.env.RIVETARI_SHOTS_DIR;

/**
 * The window, made tall enough for the whole view first: the view scrolls
 * inside the window, so a full-page shot alone would cut it off.
 */
async function shot(page: Page, name: string): Promise<void> {
  const testInfo = test.info();
  const path = shotsDir
    ? join(shotsDir, `${name}.png`)
    : testInfo.outputPath(`${name}.png`);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  const size = page.viewportSize();
  const height = await page
    .locator("main")
    .evaluate((main) => main.scrollHeight);
  await page.setViewportSize({
    width: size?.width ?? 1140,
    height: Math.max(height, size?.height ?? 0),
  });
  await page.screenshot({ path });
  if (size) await page.setViewportSize(size);
  await testInfo.attach(name, { path, contentType: "image/png" });
}

test.describe("history", () => {
  let launched: LaunchedApp | undefined;
  const cleanup: string[] = [];

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
    launched = undefined;
    for (const dir of cleanup.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  test("shows spend, the cost trend, findings, cost flags and closed tasks", async () => {
    const repo = historyRepo();
    const config = mkdtempSync(join(tmpdir(), "rivetari-e2e-config-"));
    cleanup.push(repo, config);
    launched = await launchApp({
      repos: [{ path: repo, name: "history-repo" }],
      env: { RIVETARI_LEDGER_KEY: LEDGER_KEY, RIVETARI_CONFIG_DIR: config },
    });
    const { page } = launched;

    await page
      .getByRole("button", { name: /history-repo/ })
      .first()
      .click();

    const tabs = page.getByRole("tab");
    await expect(tabs.nth(2)).toHaveText("Project");
    await expect(tabs.nth(3)).toHaveText("History");
    await page.getByRole("tab", { name: "History" }).click();

    const panel = page.locator("#panel-history");
    await expect(
      panel.getByRole("heading", { name: "History", exact: true }),
    ).toBeVisible();
    await expect(panel).toContainText("2 closed · 1 merged · $3.20 spent");

    const spend = panel.getByRole("region", { name: "Spend" });
    await expect(spend).toContainText("Total spend");
    await expect(spend).toContainText("$3.20");
    // The judge's $0.30 and $0.50 over the $3.20 the two tasks cost.
    await expect(spend).toContainText("25%");

    const trend = panel.getByRole("region", { name: "Cost trend" });
    await expect(
      trend.getByRole("img", { name: /Spend trend over 2 closing days/ }),
    ).toBeVisible();
    await trend.getByRole("button", { name: "Show as table" }).click();
    await expect(
      trend.getByRole("table", { name: "Spend by day, oldest first" }),
    ).toBeVisible();
    await trend.getByRole("button", { name: "Show as chart" }).click();

    const findings = panel.getByRole("region", { name: "Judge findings" });
    await expect(findings).toContainText("missing-csp");
    await expect(findings).toContainText(
      "Candidate rules (a pattern seen in 2+ PRs)",
    );
    await expect(findings).toContainText(
      "missing-csp · blocking: Missing CSP directive (#11, T-0002)",
    );

    const flags = panel.getByRole("region", { name: "Cost flags" });
    await expect(flags).toContainText("T-0001 · $1.20");
    await expect(flags).not.toContainText("T-0002");

    await expect(panel).not.toContainText("DORA");

    const tasks = panel.getByRole("region", { name: "Closed tasks" });
    await expect(tasks).toContainText("T-0001 · Tighten CSP header");
    await expect(tasks).toContainText("T-0002 · Experiment abandoned");

    await tasks.getByRole("button", { name: "Merged (1)" }).click();
    await expect(tasks).toContainText("T-0001 · Tighten CSP header");
    await expect(tasks).not.toContainText("T-0002 · Experiment abandoned");
    await tasks.getByRole("button", { name: "All (2)" }).click();

    // The PR link comes from T-0001's ledger; under E2E nothing is launched.
    await tasks
      .getByRole("button", { name: "Open PR #11 for T-0001 in the browser" })
      .click();
    await expect(tasks.getByRole("alert")).toHaveCount(0);
    // T-0002 never shipped, so it has no PR to open.
    await expect(
      tasks.getByRole("button", { name: /Open PR .* for T-0002/ }),
    ).toHaveCount(0);

    expect(await runAxe(page), "history view").toEqual([]);
    await shot(page, "history");

    // A closed task opens its detail in the Tasks tab.
    await tasks
      .getByRole("button", { name: "T-0001 · Tighten CSP header" })
      .click();
    await expect(page.getByRole("tab", { name: "Tasks" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page.locator("#panel-tasks").getByRole("region", { name: /T-0001/ }),
    ).toBeVisible();
    await shot(page, "history-task-detail");
  });
});
