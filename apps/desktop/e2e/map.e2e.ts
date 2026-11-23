import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

import { closeApp, launchApp, type LaunchedApp, runAxe } from "./helpers";

// Map tab: a fixture floorplan/index.html loads in the map's webview, and what
// it asks for outside floorplan/ (the waitlist's "Notify me" post, a file
// elsewhere in the repo) is cancelled by the map's session and listed. A repo
// without a map gets the empty state saying how to make one.

const WAITLIST = "https://floorplan-waitlist.example.com/notify";

/** A repo with a drawn map whose page reaches outside floorplan/ as soon as it loads. */
function mapRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "rivetari-e2e-map-"));
  const dir = join(repo, "floorplan");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(repo, "secret.txt"), "not for the map\n");
  writeFileSync(join(dir, "architecture.json"), '{"project":"fixture"}\n');
  writeFileSync(
    join(dir, "index.html"),
    [
      "<!doctype html>",
      "<html><head><title>Fixture map</title></head><body>",
      "<h1>Fixture map</h1>",
      // A file outside floorplan/; fetch() can't read file:// at all, an img can.
      '<img src="../secret.txt" alt="">',
      "<script>",
      `fetch(${JSON.stringify(WAITLIST)}, { method: "POST", body: JSON.stringify({ email: "a@b.c" }) }).catch(() => {});`,
      'try { new WebSocket("ws://127.0.0.1:9/"); } catch {}',
      "</script>",
      "</body></html>",
      "",
    ].join("\n"),
  );
  return repo;
}

test.describe("map", () => {
  let launched: LaunchedApp | undefined;
  const made: string[] = [];

  test.afterEach(async () => {
    if (launched) await closeApp(launched);
    for (const dir of made.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  test("loads the repo's floorplan map offline, cancelling every request outside floorplan/", async () => {
    const testInfo = test.info();
    const repo = mapRepo();
    const bare = mkdtempSync(join(tmpdir(), "rivetari-e2e-nomap-"));
    made.push(repo, bare);
    launched = await launchApp({
      repos: [
        { path: repo, name: "map-repo" },
        { path: bare, name: "bare-repo" },
      ],
    });
    const { page } = launched;

    await page
      .getByRole("button", { name: /map-repo/ })
      .first()
      .click();
    await page.getByRole("tab", { name: "Map" }).click();
    const panel = page.locator("#panel-map");
    await expect(
      panel.getByRole("heading", { name: "Map", exact: true }),
    ).toBeVisible();
    await expect(panel.locator("webview")).toHaveAttribute(
      "src",
      pathToFileURL(join(repo, "floorplan", "index.html")).href,
    );

    // The page ran, and what it asked for outside floorplan/ was cancelled.
    const blocked = panel.getByRole("list", { name: "Blocked requests" });
    await expect(blocked).toContainText(WAITLIST);
    await expect(blocked).toContainText(
      pathToFileURL(join(repo, "secret.txt")).href,
    );

    await page.screenshot({ path: testInfo.outputPath("map.png") });
    await testInfo.attach("map", {
      path: testInfo.outputPath("map.png"),
      contentType: "image/png",
    });
    expect(await runAxe(page), "map").toEqual([]);

    // No map yet: say how one gets made.
    await page
      .getByRole("button", { name: /bare-repo/ })
      .first()
      .click();
    await page.getByRole("tab", { name: "Map" }).click();
    await expect(page.locator("#panel-map")).toContainText(
      "No map for this repository yet.",
    );
    await expect(page.locator("#panel-map")).toContainText("floorplan: true");
    await expect(page.locator("#panel-map webview")).toHaveCount(0);
    expect(await runAxe(page), "map empty state").toEqual([]);
  });
});
