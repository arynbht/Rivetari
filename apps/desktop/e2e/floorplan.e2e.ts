import { expect, test } from "@playwright/test";

import {
  closeApp,
  copyFixtureRepo,
  launchApp,
  type LaunchedApp,
} from "./helpers";

// Floor plan flow: the fixture ships a seeded `.rivetari/floorplan.json`, so the
// Map tab renders the persisted repository model under the map without needing
// the Claude CLI (which CI doesn't have). This verifies the floor plan's section
// and the model summary — the deterministic half of the deep-audit feature.
test.describe("floor plan", () => {
  let launched: LaunchedApp;

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
  });

  test("renders the persisted repository model under the map", async () => {
    const repoPath = copyFixtureRepo();
    launched = await launchApp({
      repos: [{ path: repoPath, name: "sample-repo" }],
    });
    const { page } = launched;

    await page
      .getByRole("button", { name: /sample-repo/ })
      .first()
      .click();

    await page.getByRole("tab", { name: "Map" }).click();

    const panel = page
      .locator("#panel-map")
      .getByRole("region", { name: "Floor plan" });
    await expect(
      panel.getByRole("heading", { name: "Floor plan" }),
    ).toBeVisible();
    // The summary line proves the persisted model loaded over IPC.
    await expect(panel.getByText(/\d+ systems · \d+ nodes/)).toBeVisible();
  });
});
