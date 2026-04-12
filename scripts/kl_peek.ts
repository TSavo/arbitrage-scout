/**
 * Read-only peek at the user's current browser state via CDP.
 * Does NOT navigate, does NOT open new tabs, does NOT close anything.
 */
import { chromium } from "playwright";

async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = b.contexts()[0]!;
  const pages = ctx.pages();
  console.log(`${pages.length} tabs in shared Chrome:\n`);
  for (const p of pages) {
    try {
      const url = p.url();
      const title = await p.title().catch(() => "?");
      const isKl = url.includes("klwines.com");
      // For klwines tabs, also sample a bit of body content to confirm real page
      let snippet = "";
      if (isKl) {
        snippet = await p
          .evaluate(() => document.body?.innerText?.slice(0, 200).replace(/\s+/g, " ") ?? "")
          .catch(() => "(eval failed)");
      }
      console.log(`  ${isKl ? "⭐" : "  "} "${title.slice(0, 60)}"`);
      console.log(`     ${url.slice(0, 120)}`);
      if (snippet) console.log(`     body: "${snippet}"`);
    } catch (err) {
      console.log(`  ?? (read error: ${(err as Error).message})`);
    }
  }
  // Intentionally do NOT close the browser connection or any page.
  // Disconnect without close.
  await b.close(); // close only disconnects the CDP session, not the browser
}
main().catch((e) => { console.error(e); process.exit(1); });
