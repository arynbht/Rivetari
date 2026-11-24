import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { closeApp, launchApp, type LaunchedApp, runAxe } from "./helpers";
import { homeRepos } from "./home-fixture";
import { LEDGER_KEY } from "./tasks-fixture";

// Home, before a repo is picked: one card per registered repo with what's
// running, what needs the owner, main's CI (signed out here, so it says so),
// spend this week, the posture gate and the configured autonomy level. A card
// opens its repo on the Now tab, the sidebar's Home comes back to it, and axe
// finds nothing serious. Screenshots go to RIVETARI_SHOTS_DIR when it's set.

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

test.describe("home", () => {
  let launched: LaunchedApp | undefined;
  const cleanup: string[] = [];

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
    launched = undefined;
    for (const dir of cleanup.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  test("shows each registered repo's line and opens a repo from it", async () => {
    const { busy, audited } = homeRepos();
    // A private config dir: no sign-in, and no ledger key but the fixture's.
    const config = mkdtempSync(join(tmpdir(), "rivetari-e2e-config-"));
    cleanup.push(busy, audited, config);
    launched = await launchApp({
      repos: [
        { path: busy, name: "busy-repo" },
        { path: audited, name: "audited-repo" },
      ],
      env: { RIVETARI_LEDGER_KEY: LEDGER_KEY, RIVETARI_CONFIG_DIR: config },
    });
    const { page } = launched;

    await expect(
      page.getByRole("heading", { name: "Home", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Home", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    await expect(page.getByRole("main")).toContainText(
      "2 repositories · 1 running · 5 waiting on you",
    );

    const busyCard = page.getByRole("article", { name: "busy-repo" });
    await expect(busyCard).toContainText("T-0006 · build");
    await expect(busyCard).toContainText("Card to confirm: T-0001");
    await expect(busyCard).toContainText("Route to approve: T-0002");
    await expect(busyCard).toContainText("Stop-and-ask: T-0003");
    await expect(busyCard).toContainText("and 2 more");
    await expect(busyCard).toContainText("sign in to see CI");
    await expect(busyCard).toContainText("$1.25 closed in the last 7 days");
    await expect(busyCard).toContainText(
      "no audit recorded yet: run rivetari audit",
    );
    await expect(busyCard).toContainText("supervised (configured)");

    const auditedCard = page.getByRole("article", { name: "audited-repo" });
    await expect(auditedCard).toContainText("nothing running");
    await expect(auditedCard).toContainText("nothing waiting");
    await expect(auditedCard).toContainText("sign in to see CI");
    await expect(auditedCard).toContainText("$0.00 closed in the last 7 days");
    // The same lens Posture shows: scaffold declared, build inferred, and two
    // controls between build and harden.
    await expect(auditedCard).toContainText(
      "declared scaffold · inferred build",
    );
    await expect(auditedCard).toContainText(
      "2 controls between build and harden",
    );
    await expect(auditedCard).toContainText("(configured)");

    expect(await runAxe(page), "home").toEqual([]);
    await shot(page, "home");

    // A card opens its repo on the Now tab.
    await busyCard.getByRole("button", { name: "Open busy-repo" }).click();
    await expect(page.getByRole("tab", { name: "Now" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(
      page
        .locator("#panel-now")
        .getByRole("heading", { name: "Now", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Home", exact: true }),
    ).toHaveCount(0);

    // The sidebar's Home comes back to every repo's line.
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await expect(
      page.getByRole("article", { name: "audited-repo" }),
    ).toContainText("declared scaffold · inferred build");
  });

  test("says how to start when no repo is registered", async () => {
    const config = mkdtempSync(join(tmpdir(), "rivetari-e2e-config-"));
    cleanup.push(config);
    launched = await launchApp({
      repos: [],
      env: { RIVETARI_CONFIG_DIR: config },
    });
    const { page } = launched;
    await expect(
      page.getByRole("heading", { name: "Home", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("main")).toContainText(
      "No repositories yet. Add a local folder on the left to get started.",
    );
    expect(await runAxe(page), "home, no repos").toEqual([]);
    await shot(page, "home-empty");
  });
});
