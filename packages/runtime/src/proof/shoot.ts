// Screenshots at each of the repo's widths, once the page has really
// rendered, and an axe pass at each, with Playwright's own Chromium
// (`npx playwright install chromium` is the one install it needs).
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";

import { looksLikeSecret } from "@arynbht/rivetari-engine";
import type { Browser, Page } from "playwright-core";

import {
  type ReadyConfig,
  readySelectorFor,
  waitUntilRendered,
} from "./ready.js";

/** The default widths, and the names their images have always had. */
export const BREAKPOINTS = [
  { name: "sm", width: 375, height: 812 },
  { name: "md", width: 768, height: 1024 },
  { name: "lg", width: 1280, height: 800 },
] as const;

export const DEFAULT_WIDTHS: readonly number[] = BREAKPOINTS.map(
  (b) => b.width,
);

/** Seconds a page has to really render once it loads, unless the profile says. */
export const RENDER_TIMEOUT_S = 30;

/**
 * After one width of a page never renders, the rest of its widths get this
 * long: the page is broken, and waiting the full time again only costs.
 */
const RETRY_RENDER_MS = 5000;

/** A width as a breakpoint: sm, md and lg keep their names, others are w<width>. */
export function breakpointFor(width: number): {
  name: string;
  width: number;
  height: number;
} {
  const known = BREAKPOINTS.find((b) => b.width === width);
  if (known) return { ...known };
  return {
    name: `w${width}`,
    width,
    height: width < 600 ? 812 : width < 1024 ? 1024 : 800,
  };
}

export interface Shot {
  page: string;
  breakpoint: string;
  /** Absolute path of the PNG. */
  file: string;
  /** The page's HTTP status (0 when there was no response). */
  status: number;
  /** What was measured on the page, so a text-only reviewer can judge the shot. */
  layout?: Layout | undefined;
  /** The viewport's width in CSS pixels. */
  width?: number | undefined;
  /** The PNG's size: a loading skeleton is a fraction of the real page's. */
  bytes?: number | undefined;
  /** Whether the page really rendered before the shot. */
  ready?: boolean | undefined;
  /** Why it didn't, when it didn't: the shot is of whatever showed at the timeout. */
  notReady?: string | undefined;
}

export interface Layout {
  /** The viewport's width and the page's scroll width, in CSS pixels. */
  viewport: number;
  scrollWidth: number;
  /** Up to five visible elements that reach past the viewport's edge. */
  overflowing: string[];
  /** The start of the page's visible text. */
  text?: string | undefined;
}

// Runs in the page; a string, so this package needs no DOM types.
const MEASURE = String.raw`(() => {
  const vw = document.documentElement.clientWidth;
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
    (typeof el.className === "string" && el.className.trim()
      ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".")
      : "");
  const overflowing = [];
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 1 || r.left < -1) {
      overflowing.push(name(el) + " (" + Math.round(r.left) + "px to " + Math.round(r.right) + "px)");
      if (overflowing.length >= 5) break;
    }
  }
  const text = (document.body ? document.body.innerText : "")
    .replace(/\s+/g, " ").trim().slice(0, 200);
  return { viewport: vw, scrollWidth: document.documentElement.scrollWidth, overflowing, text };
})()`;

/** Measure the page; one that can't be measured just has no layout. */
async function measure(page: Page): Promise<Layout | undefined> {
  try {
    const layout = (await page.evaluate(MEASURE)) as Layout;
    return looksLikeSecret(layout.text ?? "")
      ? { ...layout, text: undefined }
      : layout;
  } catch {
    return undefined;
  }
}

export interface AxeViolation {
  id: string;
  impact: string;
  page: string;
  nodes: number;
  /** The breakpoint it was found at (axe runs at every width). */
  breakpoint?: string | undefined;
}

/** A page path as a file-name part: "/" → "home", "/settings/a" → "settings-a". */
export function pageSlug(page: string): string {
  return (
    page
      .replace(/[?#].*$/, "")
      .replace(/^\/+|\/+$/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .toLowerCase() || "home"
  );
}

async function launch(): Promise<Browser> {
  // Loaded on use: only the prove beat needs a browser (and the Action's
  // bundle leaves Playwright out).
  const { chromium } = await import("playwright-core");
  try {
    return await chromium.launch();
  } catch (first) {
    // Fall back to an installed Chrome or Edge before giving up.
    for (const channel of ["chrome", "msedge"]) {
      try {
        return await chromium.launch({ channel });
      } catch {
        // next
      }
    }
    throw new Error(
      `no browser for the UI proof: run \`npx playwright install chromium\` (${(first as Error).message.split("\n")[0]})`,
    );
  }
}

/** Can the UI proof run here? (False with no Chromium, Chrome or Edge.) */
export async function browserAvailable(): Promise<boolean> {
  try {
    await (await launch()).close();
    return true;
  } catch {
    return false;
  }
}

const axeSource = async (): Promise<string> =>
  readFile(
    createRequire(import.meta.url).resolve("axe-core/axe.min.js"),
    "utf8",
  );

/** Run axe on the page; the serious and critical violations it finds. */
async function runAxe(
  page: Page,
  source: string,
): Promise<{ id: string; impact: string; nodes: number }[]> {
  await page.addScriptTag({ content: source });
  const found = await page.evaluate(async () => {
    const axe = (
      globalThis as unknown as {
        axe: {
          run(): Promise<{
            violations: {
              id: string;
              impact: string | null;
              nodes: unknown[];
            }[];
          }>;
        };
      }
    ).axe;
    const result = await axe.run();
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact ?? "minor",
      nodes: v.nodes.length,
    }));
  });
  return found.filter((v) => v.impact === "serious" || v.impact === "critical");
}

/**
 * Shoot every page at every width into `outDir` as
 * `<prefix>-<n>-<page>-<breakpoint>.png` (n keeps similar pages apart), each
 * once the page has really rendered (see ready.ts); with `axe`, also return
 * the serious and critical violations on each page at each width. A page that
 * never renders is still shot, so a person can see what it showed, but marked
 * not ready, and axe doesn't run on it.
 */
export async function shoot(options: {
  baseUrl: string;
  pages: readonly string[];
  outDir: string;
  prefix: string;
  axe?: boolean | undefined;
  /** A Playwright storageState file every page loads (signed in by proof.auth). */
  storageState?: string | undefined;
  /** Viewport widths in CSS pixels (default 375, 768 and 1280). */
  widths?: readonly number[] | undefined;
  /** `proof.ready`: what shows each page has rendered. */
  ready?: ReadyConfig | undefined;
  /** How long each page has to render once it loads (default 30s). */
  renderTimeoutMs?: number | undefined;
}): Promise<{ shots: Shot[]; violations: AxeViolation[] }> {
  const browser = await launch();
  const shots: Shot[] = [];
  const violations: AxeViolation[] = [];
  const source = options.axe ? await axeSource() : "";
  const breakpoints = (options.widths ?? DEFAULT_WIDTHS).map(breakpointFor);
  const renderMs = options.renderTimeoutMs ?? RENDER_TIMEOUT_S * 1000;
  try {
    // Pages are paths under the app's URL, which may have a base path.
    const root = options.baseUrl.endsWith("/")
      ? options.baseUrl
      : `${options.baseUrl}/`;
    for (const [i, path] of options.pages.entries()) {
      const url = new URL(path.replace(/^\/+/, ""), root).toString();
      const selector = readySelectorFor(path, options.ready);
      let failedOnce = false;
      for (const bp of breakpoints) {
        // bypassCSP: the axe script is injected inline, which an app's own
        // Content-Security-Policy would (rightly, for users) block.
        const page = await browser.newPage({
          bypassCSP: true,
          viewport: { width: bp.width, height: bp.height },
          ...(options.storageState
            ? { storageState: options.storageState }
            : {}),
        });
        // Load, then wait for the real page: network idle alone is how a
        // skeleton got shot and passed.
        const res = await page.goto(url, {
          waitUntil: "load",
          timeout: 30_000,
        });
        const readiness = await waitUntilRendered(page, {
          selector,
          timeoutMs: failedOnce
            ? Math.min(renderMs, RETRY_RENDER_MS)
            : renderMs,
        });
        if (!readiness.ready) failedOnce = true;
        const file = join(
          options.outDir,
          `${options.prefix}-${i + 1}-${pageSlug(path)}-${bp.name}.png`,
        );
        await page.screenshot({ path: file, fullPage: true });
        shots.push({
          page: path,
          breakpoint: bp.name,
          file,
          status: res?.status() ?? 0,
          layout: await measure(page),
          width: bp.width,
          bytes: (await stat(file)).size,
          ready: readiness.ready,
          ...(readiness.ready ? {} : { notReady: readiness.reason }),
        });
        // axe on a page that never rendered would grade the loading state.
        if (options.axe && readiness.ready) {
          for (const v of await runAxe(page, source))
            violations.push({ ...v, page: path, breakpoint: bp.name });
        }
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return { shots, violations };
}
