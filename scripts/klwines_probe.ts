/**
 * Probe each K&L feed URL: navigate existing tab, report structure.
 * No changes to state — read-only DOM inspection.
 */
import { chromium } from "playwright";

const feeds = [
  { name: "auction_216", url: "https://www.klwines.com/Products?&filters=sv2_dflt-stock-instock!30$eq$(216)$True$ff-30-(216)--$!88$eq$1$True$ff-88-1--$&orderBy=60%20asc,search.score()%20desc,74%20asc" },
  { name: "auction_227_group", url: "https://www.klwines.com/Products?&filters=sv2_dflt-stock-instock!30$eq$(227)$True$ff-30-(227)--$or,220.or,219.or,215.or,218!88$eq$1$True$ff-88-1--$&orderBy=60%20asc,search.score()%20desc,74%20asc" },
  { name: "new_product", url: "https://www.klwines.com/p/Index?filters=sv2_NewProductFeedYN%24eq%241%24True%24ProductFeed%24%21dflt-stock-all&orderBy=NewProductFeedDate%20desc" },
];

async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = b.contexts()[0]!;
  const page = ctx.pages().find(p => p.url().includes("klwines.com"))!;
  if (!page) throw new Error("no klwines tab");

  for (const f of feeds) {
    console.log(`\n═══ ${f.name} ═══`);
    console.log(`URL: ${f.url.slice(0, 110)}...`);
    await page.goto(f.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(3500);

    const info = await page.evaluate(() => {
      const trsWithProduct = Array.from(document.querySelectorAll("tr")).filter(t => t.querySelector('a[href*="/p/"]'));
      const productAnchors = Array.from(document.querySelectorAll('a[href*="/p/"]'))
        .filter(a => /\/p\/[^/]+\/\d+/.test((a as HTMLAnchorElement).href));

      // Try to find the enclosing "card" for a product anchor — may not be a <tr>
      const firstAnchor = productAnchors[0] as HTMLAnchorElement | undefined;
      let cardSelector: string | null = null;
      let cardHtml: string | null = null;
      if (firstAnchor) {
        let n: HTMLElement | null = firstAnchor;
        for (let i = 0; i < 8 && n; i++) {
          n = n.parentElement;
          if (n && n.children.length >= 3) {
            cardSelector = n.tagName + (n.className ? "." + String(n.className).split(/\s+/).slice(0,3).join(".") : "");
            cardHtml = n.outerHTML.slice(0, 800);
            break;
          }
        }
      }

      return {
        title: document.title,
        productAnchorCount: productAnchors.length,
        trRowCount: trsWithProduct.length,
        sampleHrefs: productAnchors.slice(0, 3).map(a => (a as HTMLAnchorElement).href.slice(0, 100)),
        cardSelector,
        cardHtml,
        paginationHint: document.querySelector('.page-filters-block')?.textContent?.replace(/\s+/g,' ').trim().slice(0, 200) ?? null,
      };
    });
    console.log(JSON.stringify(info, null, 2));
  }

  await b.close();
}
main().catch(e => { console.error(e); process.exit(1); });
