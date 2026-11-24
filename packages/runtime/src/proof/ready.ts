// Has the page really rendered? A screenshot taken at network idle can still
// be the loading skeleton a client-side fetch replaces a moment later, which
// is how every UI proof in the BreathBand pilot passed on a skeleton. So
// before a shot the page must show the repo's named ready selector, or, with
// none named, settle: network idle, no visible loading marker, and a DOM that
// has stopped changing. A page that never gets there isn't shot as passed.
import picomatch from "picomatch";
import type { Page } from "playwright-core";

/** `proof.ready` from the profile: one selector, or one per page. */
export type ReadyConfig = string | Readonly<Record<string, string>>;

export type Readiness =
  { ready: true; how: string } | { ready: false; reason: string };

/** How long the DOM must go without a change to count as settled. */
export const QUIET_MS = 500;

/**
 * The ready selector for a page: an exact path (with or without its query,
 * trailing slash ignored) wins, then the first glob in the map that matches,
 * then `*`.
 */
export function readySelectorFor(
  page: string,
  config: ReadyConfig | undefined,
): string | undefined {
  if (config === undefined) return undefined;
  if (typeof config === "string") return config;
  const trim = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const path = trim(page.replace(/[?#].*$/, "") || "/");
  const exact = Object.entries(config).find(
    ([key]) => trim(key) === trim(page) || trim(key) === path,
  );
  if (exact) return exact[1];
  const glob = Object.entries(config).find(
    ([key]) =>
      key !== "*" && /[*?[{]/.test(key) && picomatch.isMatch(path, key),
  );
  return glob?.[1] ?? config["*"];
}

// Runs in the page; a string, so this package needs no DOM types. Returns a
// short name for the first visible loading marker, or null when there's none.
const LOADING = String.raw`(() => {
  const marked = '[aria-busy="true"], [data-loading]:not([data-loading="false"]), [data-skeleton], [data-state="loading"], [role="progressbar"]:not([aria-valuenow])';
  const classes = /(?:^|[\s_-])(?:skeleton|shimmer|spinner|loader|loading|animate-pulse|animate-spin|placeholder-glow|placeholder-wave)(?:$|[\s_-])/i;
  const words = /^(?:loading|please wait)(?:\.\.\.|…|\.)?$/i;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    // A 1px box is screen-reader-only text: a live region, not a skeleton.
    if (r.width <= 1 || r.height <= 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) !== 0;
  };
  const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") +
    (el.getAttribute("class") ? "." + el.getAttribute("class").trim().split(/\s+/).slice(0, 2).join(".") : "") +
    (el.getAttribute("aria-busy") === "true" ? '[aria-busy="true"]' : "");
  if (!document.body) return "an empty document";
  for (const el of document.body.querySelectorAll(marked)) if (visible(el)) return name(el);
  for (const el of document.body.querySelectorAll("[class]")) {
    if (classes.test(el.getAttribute("class") || "") && visible(el)) return name(el);
  }
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const el = n.parentElement;
    if (el && words.test((n.nodeValue || "").trim()) && visible(el)) return name(el) + ' "' + n.nodeValue.trim() + '"';
  }
  return null;
})()`;

// Resolves true once nothing is added, removed or retyped for the quiet
// window, false at the deadline. Attribute changes don't count: CSS-driven
// animation rewrites style and class every frame without the page changing.
const settle = (
  quietMs: number,
  withinMs: number,
) => String.raw`new Promise((resolve) => {
  let timer;
  const done = (v) => { clearTimeout(timer); clearTimeout(limit); observer.disconnect(); resolve(v); };
  const observer = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(() => done(true), ${quietMs}); });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  timer = setTimeout(() => done(true), ${quietMs});
  const limit = setTimeout(() => done(false), ${withinMs});
})`;

const seconds = (ms: number) => `${Math.round(ms / 100) / 10}s`;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until the page has really rendered, within `timeoutMs` of now. With a
 * selector, that's the selector visible; without one, the default settling.
 */
export async function waitUntilRendered(
  page: Page,
  options: { selector?: string | undefined; timeoutMs: number },
): Promise<Readiness> {
  const { selector, timeoutMs } = options;
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(0, deadline - Date.now());
  const fonts = () =>
    page
      .evaluate("document.fonts ? document.fonts.ready.then(() => true) : true")
      .catch(() => true);
  if (selector) {
    try {
      await page
        .locator(selector)
        .first()
        .waitFor({ state: "visible", timeout: Math.max(1, left()) });
    } catch (err) {
      const why = (err as Error).message.split("\n")[0] ?? "";
      return {
        ready: false,
        reason: /Timeout/i.test(why)
          ? `the ready selector "${selector}" never showed within ${seconds(timeoutMs)}`
          : `the ready selector "${selector}" couldn't be checked: ${why}`,
      };
    }
    await fonts();
    return { ready: true, how: `"${selector}" showed` };
  }

  // A page that can't be checked (mid-navigation, say) counts as loading:
  // never as rendered.
  const loading = (): Promise<string | null> =>
    page
      .evaluate(LOADING)
      .then((m) => m as string | null)
      .catch(
        (err: Error) =>
          `a page that couldn't be checked (${err.message.split("\n")[0] ?? ""})`,
      );
  const busy =
    " (if the page is meant to stay busy, name what shows it's rendered in proof.ready)";
  // A marker can come back after the DOM settles (a second fetch starts), so
  // the whole sequence repeats until one pass sees nothing loading.
  for (;;) {
    try {
      await page.waitForLoadState("networkidle", {
        timeout: Math.max(1, left()),
      });
    } catch {
      return {
        ready: false,
        reason: `the network never went idle within ${seconds(timeoutMs)}${busy}`,
      };
    }
    let marker = await loading();
    while (marker && left() > 0) {
      await pause(Math.min(100, left()));
      marker = await loading();
    }
    if (marker)
      return {
        ready: false,
        reason: `still showing a loading state after ${seconds(timeoutMs)}: ${marker}${busy}`,
      };
    const settled =
      left() > 0 &&
      (await page.evaluate(settle(QUIET_MS, left())).catch(() => false));
    if (!settled)
      return {
        ready: false,
        reason: `the page kept changing for ${seconds(timeoutMs)}${busy}`,
      };
    const again = await loading();
    if (!again) break;
    if (left() === 0)
      return {
        ready: false,
        reason: `still showing a loading state after ${seconds(timeoutMs)}: ${again}${busy}`,
      };
  }
  await fonts();
  return {
    ready: true,
    how: "network idle, no loading marker, the DOM settled",
  };
}
