/**
 * Shared headed-Chrome browser for every Playwright-based adapter.
 *
 * The problem with the old approach: each adapter called
 * `chromium.launch({ headless: true })` to spin up its own bundled
 * Chromium. That meant (a) N heavy browser launches in parallel, (b) a
 * detectable "headless bundled Chromium" footprint that sites like
 * Whatnot / Mercari / LiveAuctioneers / HiBid fingerprint and block, and
 * (c) no shared cookies / persistent session across runs.
 *
 * The fix: every adapter goes through `getSharedBrowser()` which connects
 * over CDP to the real Chrome instance the user keeps running on
 * localhost:9222 (same instance K&L uses — a true headed browser with a
 * persistent user-data-dir, real cookies, real fingerprint). One browser
 * process, N tabs, realistic bot-detection profile.
 *
 * The user launches that Chrome with something like:
 *   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
 *     --remote-debugging-port=9222 \
 *     --user-data-dir=data/sessions/klwines \
 *     --disable-features=OmniboxAimPopup,Aim,AimPrefetching
 *
 * Once that's up, adapters call `withSharedPage(fn)` to run a scoped
 * operation inside a fresh tab on the shared browser.
 */

import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { log, error as logError } from "@/lib/logger";

const DEFAULT_CDP_URL = process.env.CHROME_CDP_URL ?? "http://127.0.0.1:9222";

let connectPromise: Promise<Browser> | null = null;

/**
 * Get (or lazily initialize) the shared browser connection. Safe to call
 * concurrently — all callers share a single connection attempt.
 */
export function getSharedBrowser(): Promise<Browser> {
  if (!connectPromise) {
    connectPromise = (async () => {
      log("shared-browser", `connecting over CDP: ${DEFAULT_CDP_URL}`);
      try {
        const b = await chromium.connectOverCDP(DEFAULT_CDP_URL);
        log("shared-browser", "connected");
        // Reset cache on disconnect so subsequent callers retry instead of
        // holding a dead reference.
        b.on("disconnected", () => {
          log("shared-browser", "disconnected");
          connectPromise = null;
        });
        return b;
      } catch (err) {
        connectPromise = null;
        throw err;
      }
    })();
  }
  return connectPromise;
}

/** Resolve to the first context on the shared browser, create if missing. */
export async function getSharedContext(): Promise<BrowserContext> {
  const browser = await getSharedBrowser();
  const ctx = browser.contexts()[0];
  if (ctx) return ctx;
  return await browser.newContext();
}

/**
 * Run `fn` with a fresh tab on the shared browser. Closes the tab on exit
 * even if `fn` throws. Prefer this over `context.newPage()` directly so
 * tab cleanup is centralized.
 */
export async function withSharedPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const ctx = await getSharedContext();
  const page = await ctx.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

/** Explicit shutdown — call at end-of-scan. Next call reconnects. */
export async function closeSharedBrowser(): Promise<void> {
  if (!connectPromise) return;
  try {
    const b = await connectPromise;
    await b.close();
  } catch (err) {
    logError("shared-browser", "close failed", err);
  } finally {
    connectPromise = null;
  }
}
