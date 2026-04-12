/**
 * Isolated K&L test — proves the adapter reuses the user's existing
 * logged-in tab rather than opening a new one.
 *
 * Flow:
 *   1. Peek: show the user's current klwines tab (must exist).
 *   2. Instantiate KlwinesAdapter.
 *   3. Call it once — log which tab it actually ended up driving.
 *   4. Watch that navigation happens in that tab (not a new one).
 *   5. Scrape one page. Report row count.
 */
import { chromium, type Page } from "playwright";
import { KlwinesAdapter } from "@/sources/klwines";

async function tabId(page: Page): Promise<string> {
  // Playwright doesn't expose CDP target IDs directly; use a stable
  // fingerprint of url+title to track which tab we're on.
  return `${page.url().slice(0, 60)} :: ${await page.title().catch(() => "?")}`;
}

async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = b.contexts()[0]!;
  const before = ctx.pages();
  console.log(`STATE BEFORE (${before.length} tabs):`);
  for (const p of before) {
    console.log(`  ${p.url().slice(0, 100)}  title="${(await p.title()).slice(0, 60)}"`);
  }

  const klTabs = before.filter((p) => p.url().includes("klwines.com"));
  console.log(`\nFound ${klTabs.length} existing K&L tab(s)`);
  if (klTabs.length === 0) {
    console.log("ERROR: no K&L tab — adapter can't reuse it; aborting");
    await b.close();
    return;
  }
  const originalKlUrl = klTabs[0].url();
  const originalKlTitle = await klTabs[0].title();
  console.log(`  target: "${originalKlTitle.slice(0, 60)}"  ${originalKlUrl.slice(0, 80)}`);

  // Hook navigation events so we SEE what tab the adapter drives
  for (const p of ctx.pages()) {
    p.on("framenavigated", (f) => {
      if (f === p.mainFrame()) {
        console.log(`  [tab nav] ${f.url().slice(0, 110)}`);
      }
    });
  }
  ctx.on("page", async (p) => {
    console.log(`  [tab NEW OPENED] ${p.url().slice(0, 110)}`);
  });

  const adapter = new KlwinesAdapter();
  console.log(`\n── running adapter.search("")  ──`);
  const t0 = Date.now();
  const listings = await adapter.search("", { limit: 3 });
  const elapsed = Date.now() - t0;
  console.log(`\nadapter returned ${listings.length} listings in ${elapsed}ms`);
  for (const l of listings) {
    console.log(`  ${(l as { title: string }).title?.slice(0, 80)}`);
  }

  const after = ctx.pages();
  console.log(`\nSTATE AFTER (${after.length} tabs):`);
  for (const p of after) {
    console.log(`  ${p.url().slice(0, 100)}  title="${(await p.title()).slice(0, 60)}"`);
  }
  console.log(`\nNew tabs opened: ${after.length - before.length}`);
  await adapter.close();
  await b.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
