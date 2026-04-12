import { chromium } from "playwright";

async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = b.contexts()[0]!;
  const page = ctx.pages().find(p => p.url().includes("klwines.com"))!;

  const auctionUrl = "https://www.klwines.com/Products?&filters=sv2_dflt-stock-instock!30$eq$(216)$True$ff-30-(216)--$!88$eq$1$True$ff-88-1--$&orderBy=60%20asc,search.score()%20desc,74%20asc";
  await page.goto(auctionUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(5000);

  const info = await page.evaluate(() => {
    // Every internal link, not just /p/
    const pathBuckets: Record<string, string[]> = {};
    for (const a of Array.from(document.querySelectorAll('a[href]'))) {
      const h = (a as HTMLAnchorElement).getAttribute('href') || '';
      if (!h || h.startsWith('#') || h.startsWith('javascript:') || /\/(Static|Content|Scripts)\//.test(h) || /^mailto:|^tel:|^https:/.test(h)) continue;
      const m = h.match(/^(\/[^/?]+)/);
      const k = m ? m[1] : h.slice(0,12);
      (pathBuckets[k] ??= []).push(h);
    }
    const topBuckets = Object.entries(pathBuckets)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 8)
      .map(([k, v]) => ({ prefix: k, count: v.length, samples: v.slice(0, 2) }));

    // Find plausible product cards
    const candidates = Array.from(document.querySelectorAll('[class]'))
      .filter(el => {
        const c = (el as HTMLElement).className || '';
        return typeof c === 'string' && /product|result|item|lot|auction|tile|card/i.test(c)
          && (el as HTMLElement).querySelectorAll('a').length > 0;
      })
      .slice(0, 4)
      .map(el => ({
        selector: `${el.tagName}.${String((el as HTMLElement).className).split(/\s+/).slice(0,3).join('.')}`,
        anchorCount: el.querySelectorAll('a').length,
        html: (el as HTMLElement).outerHTML.slice(0, 600),
      }));

    return { url: location.href, title: document.title, topBuckets, candidates };
  });
  console.log(JSON.stringify(info, null, 2));
  await b.close();
}
main().catch(e => { console.error(e); process.exit(1); });
