/**
 * K&L Wines login helper — spawns the real Chrome binary (not Playwright's
 * bundled Chromium) with a remote-debugging port, then connects over CDP.
 *
 * Using the real Chrome avoids the automation fingerprints (Navigator.webdriver,
 * bundled Chromium UA, test-build differences) that sites like K&L use for bot
 * detection. Cookies persist in the dedicated user-data-dir — future scraper
 * runs re-launch Chrome against the same dir and inherit the authenticated
 * session.
 *
 * Usage:
 *   npx tsx scripts/klwines_login.ts
 *
 * Log in manually, then close the browser window. Script exits when Chrome
 * exits.
 */

import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { resolve } from "node:path";
import { mkdirSync } from "node:fs";

const USER_DATA_DIR = resolve("data/sessions/klwines");
const CDP_PORT = 9222;
const START_URL = "https://www.klwines.com/";
const CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function waitForCdp(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Chrome CDP never came up on port ${port}`);
}

async function main(): Promise<void> {
  mkdirSync(USER_DATA_DIR, { recursive: true });

  console.log(`[klwines-login] user-data-dir: ${USER_DATA_DIR}`);
  console.log(`[klwines-login] launching real Chrome with CDP on :${CDP_PORT}`);

  const chrome = spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${USER_DATA_DIR}`,
      "--no-first-run",
      "--no-default-browser-check",
      // Chrome's new omnibox "AI Mode" (aim) steals focus from forms and
      // routes keystrokes to the URL bar. Disable it plus related ML UI
      // features so the page is actually usable.
      "--disable-features=OmniboxAimPopup,Aim,AimPrefetching,OmniboxMlLogUrlScoringSignals,OmniboxMiaZPS",
      "about:blank",
    ],
    { stdio: "ignore", detached: false },
  );

  chrome.on("error", (err) => {
    console.error("[klwines-login] chrome spawn failed:", err);
    process.exit(1);
  });

  await waitForCdp(CDP_PORT);
  console.log("[klwines-login] CDP up — connecting.");

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const contexts = browser.contexts();
  const ctx = contexts[0] ?? (await browser.newContext());
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  console.log(`[klwines-login] connected. navigating to ${START_URL}`);
  try {
    await page.goto(START_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (err) {
    console.warn("[klwines-login] initial navigation failed:", err);
  }
  console.log("[klwines-login] log in manually, then close the Chrome window.");

  await new Promise<void>((resolveFn) => {
    chrome.on("exit", () => resolveFn());
  });

  await browser.close().catch(() => {});
  console.log("[klwines-login] chrome exited — session saved to user-data-dir.");
}

main().catch((err) => {
  console.error("[klwines-login] failed:", err);
  process.exit(1);
});
