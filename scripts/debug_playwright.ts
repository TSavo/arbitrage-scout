/**
 * Playwright harness — tries each target URL using the EXISTING headed
 * Chrome on localhost:9222 via CDP. Real Chrome, real user data dir,
 * real cookies — no headless bundled-Chromium detection footprint.
 *
 * Requires Chrome already running with --remote-debugging-port=9222
 * (the same instance used by K&L login).
 */
import { chromium } from "playwright";

interface Target {
  readonly name: string;
  readonly url: string;
}

const TARGETS: readonly Target[] = [
  { name: "liveauctioneers", url: "https://www.liveauctioneers.com/search/?keyword=nintendo" },
  { name: "hibid",            url: "https://hibid.com/search?q=nintendo" },
  { name: "mercari",          url: "https://www.mercari.com/search/?keyword=pokemon+card" },
  { name: "whatnot",          url: "https://www.whatnot.com/search/pokemon+card" },
  { name: "klwines_auction",  url: "https://www.klwines.com/Products?&filters=sv2_dflt-stock-instock!30$eq$(216)$True$ff-30-(216)--$!88$eq$1$True$ff-88-1--$&orderBy=60%20asc,search.score()%20desc,74%20asc" },
];

async function probeKlwinesPagination(ctx: import("playwright").BrowserContext): Promise<void> {
  const url =
    "https://www.klwines.com/Products?&filters=sv2_dflt-stock-instock!30$eq$(216)$True$ff-30-(216)--$!88$eq$1$True$ff-88-1--$&orderBy=60%20asc,search.score()%20desc,74%20asc";
  const page = await ctx.newPage();
  try {
    const t0 = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForSelector('div.tf-product a[href*="/Auction/"]', { timeout: 20_000 });
    const p1 = await page.evaluate(() =>
      Array.from(document.querySelectorAll("div.tf-product-header a")).slice(0, 3).map((a) => (a as HTMLAnchorElement).textContent?.trim().slice(0, 40)),
    );
    console.log(`\n── klwines pagination (shared Chrome, CDP) ──`);
    console.log(`page 1 loaded in ${Date.now() - t0}ms`);
    console.log(`  samples: ${JSON.stringify(p1)}`);

    // Click "Go to 2 page"
    const tClick = Date.now();
    const next = page.locator('.page-filters-block a[aria-label="Go to 2 page"]').first();
    const found = await next.count();
    if (!found) {
      console.log("  ✗ no pagination link found");
      return;
    }
    await Promise.all([
      page.waitForLoadState("domcontentloaded", { timeout: 15_000 }),
      next.click(),
    ]);
    await page.waitForSelector('div.tf-product a[href*="/Auction/"]', { timeout: 15_000 });
    const p2 = await page.evaluate(() =>
      Array.from(document.querySelectorAll("div.tf-product-header a")).slice(0, 3).map((a) => (a as HTMLAnchorElement).textContent?.trim().slice(0, 40)),
    );
    console.log(`page 2 clicked in ${Date.now() - tClick}ms`);
    console.log(`  samples: ${JSON.stringify(p2)}`);

    const distinct = p1[0] !== p2[0] && p1[1] !== p2[1];
    console.log(`  ${distinct ? "✓" : "✗"} page 2 shows different content than page 1`);
  } finally {
    await page.close();
  }
}

async function main() {
  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("no CDP context — is Chrome running on :9222?");

  // Phase 1: initial goto latency per site.
  for (const t of TARGETS) {
    for (const waitUntil of ["domcontentloaded", "load", "networkidle"] as const) {
      const tag = `${t.name}/${waitUntil}`;
      const page = await ctx.newPage();
      const tGoto = Date.now();
      try {
        const resp = await page.goto(t.url, { waitUntil, timeout: 30_000 });
        const gotoMs = Date.now() - tGoto;
        const status = resp?.status() ?? -1;
        const title = await page.title().catch(() => "?");
        console.log(`✓ ${tag}  goto=${gotoMs}ms status=${status} title="${title.slice(0, 60)}"`);
      } catch (err) {
        const gotoMs = Date.now() - tGoto;
        console.log(`✗ ${tag}  goto=${gotoMs}ms FAIL: ${(err as Error).message}`);
      } finally {
        await page.close();
      }
    }
  }

  // Phase 2: prove pagination works end-to-end through the shared CDP Chrome.
  await probeKlwinesPagination(ctx);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
