import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { boardRepo } from "./board-fixture";
import { closeApp, launchApp, type LaunchedApp, runAxe } from "./helpers";
import { emptyRepo } from "./now-fixture";
import { LEDGER_KEY } from "./tasks-fixture";

// The shell's tabs after the cleanup: a repo opens on Now, Tasks sits next
// to it with its board by beat one click away, and the old tabs (Scorecard,
// Floor Plan, Profile, Gates, Fix, AI, Docs) are gone. Picking another repo
// opens it on Now again, whatever tab the last one was on. Screenshots go to
// RIVETARI_SHOTS_DIR when it's set.

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

const TABS = ["Now", "Tasks", "Posture", "Project", "History", "Map"];
const GONE = [
  "Scorecard",
  "Floor Plan",
  "Profile",
  "Gates",
  "Fix",
  "AI",
  "Docs",
];

test.describe("shell defaults", () => {
  let launched: LaunchedApp | undefined;
  const cleanup: string[] = [];

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
    launched = undefined;
    for (const dir of cleanup.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  test("a repo opens on Now, and the board is next to it", async () => {
    const repo = boardRepo();
    const other = emptyRepo();
    // A private config dir: no sign-in, and no ledger key but the fixture's.
    const config = mkdtempSync(join(tmpdir(), "t3c-config-"));
    cleanup.push(repo, other, config);
    launched = await launchApp({
      repos: [
        { path: repo, name: "board-repo" },
        { path: other, name: "empty-repo" },
      ],
      env: { RIVETARI_LEDGER_KEY: LEDGER_KEY, RIVETARI_CONFIG_DIR: config },
    });
    const { page } = launched;
    await page
      .getByRole("button", { name: /board-repo/ })
      .first()
      .click();

    // These tabs, in this order, and none of the old ones.
    await expect(page.getByRole("tab")).toHaveText(TABS);
    for (const name of GONE)
      await expect(page.getByRole("tab", { name, exact: true })).toHaveCount(0);

    // Now is the tab a repo opens on.
    const now = page.getByRole("tab", { name: "Now" });
    await expect(now).toHaveAttribute("aria-selected", "true");
    await expect(
      page
        .locator("#panel-now")
        .getByRole("heading", { name: "Now", exact: true }),
    ).toBeVisible();
    await expect(
      page.locator("#panel-now").getByRole("region", { name: /Needs you/ }),
    ).toBeVisible();
    await shot(page, "after-repo-picked");
    expect(await runAxe(page), "now on open").toEqual([]);

    // Tasks is the next tab along: the arrow key reaches it from Now.
    await now.focus();
    await page.keyboard.press("ArrowRight");
    const tasks = page.getByRole("tab", { name: "Tasks" });
    await expect(tasks).toHaveAttribute("aria-selected", "true");
    await expect(tasks).toBeFocused();

    // Its board by beat is one click away.
    const panel = page.locator("#panel-tasks");
    const toggle = panel.getByRole("group", { name: "Show tasks as" });
    await toggle.getByRole("button", { name: "Board" }).click();
    const board = panel.getByRole("region", { name: "Board", exact: true });
    await expect(board).toBeVisible();
    await expect(board.getByRole("heading", { level: 4 }).first()).toHaveText(
      /^intake/,
    );
    await shot(page, "after-tasks-board");
    expect(await runAxe(page), "tasks board").toEqual([]);

    // Another repo opens on Now too, not on the tab the last one was left on.
    await page
      .getByRole("button", { name: /empty-repo/ })
      .first()
      .click();
    await expect(page.getByRole("tab", { name: "Now" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(page.locator("#panel-tasks")).toHaveCount(0);
  });
});
