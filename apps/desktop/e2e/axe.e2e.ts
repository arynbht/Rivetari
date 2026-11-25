import { expect, test } from "@playwright/test";

import {
  closeApp,
  copyFixtureRepo,
  launchApp,
  type LaunchedApp,
  runAxe,
} from "./helpers";

// axe-core accessibility checks on each screen. Fails on any serious/critical
// violation (missing labels, roles, contrast, etc.).
test.describe("accessibility (axe)", () => {
  let launched: LaunchedApp;

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
  });

  test("each screen is free of serious/critical axe violations", async () => {
    const repoPath = copyFixtureRepo();
    launched = await launchApp({
      repos: [{ path: repoPath, name: "sample-repo" }],
    });
    const { page } = launched;

    // Empty state (no repo selected).
    expect(await runAxe(page), "empty state").toEqual([]);

    await page
      .getByRole("button", { name: /sample-repo/ })
      .first()
      .click();
    // A repo opens on Now.
    await expect(
      page
        .locator("#panel-now")
        .getByRole("heading", { name: "Now", exact: true }),
    ).toBeVisible();
    expect(await runAxe(page), "now").toEqual([]);

    await page.getByRole("tab", { name: "Posture" }).click();
    const posture = page.locator("#panel-posture");
    await posture.getByRole("button", { name: "Run audit" }).click();
    await expect(posture.getByText(/\d+ controls · recorded /)).toBeVisible();
    expect(await runAxe(page), "posture").toEqual([]);

    await page.getByRole("tab", { name: "Project" }).click();
    await expect(
      page
        .locator("#panel-project")
        .getByRole("heading", { name: "Project", exact: true }),
    ).toBeVisible();
    expect(await runAxe(page), "project").toEqual([]);

    await page.getByRole("tab", { name: "Map" }).click();
    await expect(
      page.locator("#panel-map").getByText("No map for this repository yet."),
    ).toBeVisible();
    expect(await runAxe(page), "map").toEqual([]);

    await page.getByRole("button", { name: "Settings" }).click();
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(await runAxe(page), "settings").toEqual([]);
  });
});
