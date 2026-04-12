/**
 * Verify the K&L Wines session.
 *
 * Connects to the running Chrome CDP endpoint from klwines_login.ts (or spawns
 * a fresh Chrome against the same user-data-dir if nothing is running),
 * navigates to the account page, and reports whether the session is
 * authenticated.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { chromium } from "playwright";
import { resolve } from "node:path";

const USER_DATA_DIR = resolve("data/sessions/klwines");
const CDP_PORT = 9222;
const CHROME_PATH =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function cdpAlive(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForCdp(port: number, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpAlive(port)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`CDP never came up on port ${port}`);
}

async function main(): Promise<void> {
  let spawned: ChildProcess | null = null;

  if (!(await cdpAlive(CDP_PORT))) {
    console.log("[klwines-verify] no running Chrome — spawning headed");
    spawned = spawn(
      CHROME_PATH,
      [
        `--remote-debugging-port=${CDP_PORT}`,
        `--user-data-dir=${USER_DATA_DIR}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
      { stdio: "ignore", detached: false },
    );
    await waitForCdp(CDP_PORT);
  } else {
    console.log("[klwines-verify] connecting to existing Chrome on :9222");
  }

  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("no browser context");

  const page = await ctx.newPage();
  await page.goto("https://www.klwines.com/account", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  const url = page.url();
  const title = await page.title();

  // Heuristics for logged-in vs login page.
  const html = await page.content();
  const htmlLower = html.toLowerCase();
  const markers = {
    hasLoginForm:
      /(<form[^>]*login)|(name=["']?(email|username|password)["']?)/i.test(html),
    hasSignOut: /sign\s*out|log\s*out/i.test(htmlLower),
    hasMyAccount: /my\s*account|order\s*history/i.test(htmlLower),
    hasSignIn: /sign\s*in|log\s*in/i.test(htmlLower),
    urlLooksLikeLogin: /login|signin/i.test(url),
  };

  const cookies = await ctx.cookies("https://www.klwines.com");
  const authCookie = cookies.find((c) =>
    /auth|session|sso|login|token/i.test(c.name),
  );

  console.log("\n── verify ───────────────────────────────");
  console.log(`url:    ${url}`);
  console.log(`title:  ${title}`);
  console.log(`cookies on klwines.com: ${cookies.length}`);
  if (authCookie) {
    console.log(
      `  plausible auth cookie: ${authCookie.name} (expires ${
        authCookie.expires > 0
          ? new Date(authCookie.expires * 1000).toISOString()
          : "session"
      })`,
    );
  }
  console.log("markers:", markers);

  const loggedIn =
    markers.hasSignOut ||
    (markers.hasMyAccount && !markers.hasLoginForm && !markers.urlLooksLikeLogin);

  console.log(
    `\nresult: ${
      loggedIn ? "✓ LOGGED IN" : "✗ NOT LOGGED IN (or cannot tell)"
    }`,
  );

  await page.close();
  await browser.close();

  if (spawned) {
    spawned.kill();
  }

  process.exit(loggedIn ? 0 : 1);
}

main().catch((err) => {
  console.error("[klwines-verify] failed:", err);
  process.exit(2);
});
