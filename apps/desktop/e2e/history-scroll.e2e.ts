import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { closeApp, launchApp, type LaunchedApp } from "./helpers";
import { historyRepo } from "./history-fixture";
import { LEDGER_KEY } from "./tasks-fixture";

// History with its docs scrolls once, as the page: with closed tasks and a
// doc long enough to overflow the window, and a code block wide enough to
// scroll sideways, the only thing that scrolls up and down is the page (the
// shell's main). The window doesn't scroll as well, which it did when the
// tables' screen-reader captions sat outside main's scroll. A screenshot goes
// to RIVETARI_SHOTS_DIR when it's set.

const shotsDir = process.env.RIVETARI_SHOTS_DIR;

async function shot(page: Page, name: string): Promise<void> {
  const testInfo = test.info();
  const path = shotsDir
    ? join(shotsDir, `${name}.png`)
    : testInfo.outputPath(`${name}.png`);
  if (shotsDir) mkdirSync(shotsDir, { recursive: true });
  await page.screenshot({ path });
  await testInfo.attach(name, { path, contentType: "image/png" });
}

/**
 * Everything that scrolls up and down now: each element whose overflow-y is
 * auto or scroll and whose content is taller than it, and the window itself
 * when the document is taller than it. The window scrolls with overflow-y
 * left visible, so the element rule alone would miss it.
 */
function verticalScrollers(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const scrollers = [...document.querySelectorAll("*")]
      .filter((el) => {
        const { overflowY } = getComputedStyle(el);
        return (
          (overflowY === "auto" || overflowY === "scroll") &&
          el.scrollHeight > el.clientHeight
        );
      })
      .map((el) => el.tagName.toLowerCase());
    const root = document.scrollingElement;
    if (root && root.scrollHeight > root.clientHeight) scrollers.push("window");
    return scrollers;
  });
}

test.describe("history scroll", () => {
  let launched: LaunchedApp | undefined;
  const cleanup: string[] = [];

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
    launched = undefined;
    for (const dir of cleanup.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  test("History and its docs scroll once, as the page", async () => {
    const repo = historyRepo();
    mkdirSync(join(repo, "docs"), { recursive: true });
    const paragraphs = Array.from(
      { length: 60 },
      (_, i) => `Paragraph ${i + 1} of the guide.`,
    ).join("\n\n");
    const code = Array.from(
      { length: 40 },
      (_, i) => `line ${i + 1} ${"x".repeat(300)}`,
    ).join("\n");
    writeFileSync(
      join(repo, "docs", "guide.md"),
      `# Guide\n\n${paragraphs}\n\n\`\`\`\n${code}\n\`\`\`\n\nThe end of the guide.\n`,
    );
    const config = mkdtempSync(join(tmpdir(), "t3c-config-"));
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
    await page.getByRole("tab", { name: "History" }).click();
    const panel = page.locator("#panel-history");
    await expect(
      panel.getByRole("region", { name: "Closed tasks" }),
    ).toBeVisible();
    await panel
      .getByRole("navigation", { name: "Repository docs" })
      .getByRole("button", { name: "docs/guide.md" })
      .click();
    await expect(panel).toContainText("The end of the guide.");

    // The page overflows the window, and it is the only thing that scrolls.
    expect(await verticalScrollers(page)).toEqual(["main"]);

    await panel
      .getByRole("heading", { name: "Docs", exact: true })
      .scrollIntoViewIfNeeded();
    await shot(page, "after-history");
    expect(await verticalScrollers(page)).toEqual(["main"]);
  });
});
