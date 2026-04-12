import { chromium } from "playwright";

async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = b.contexts()[0]!;
  const page = ctx.pages().find(p => p.url().includes("klwines.com"))!;
  const info = await page.evaluate(() => {
    const firstCard = document.querySelector('div.tf-product.clearfix') as HTMLElement | null;
    if (!firstCard) return { error: "no tf-product card found", url: location.href };
    // Full HTML of the first and second card so we can see the structure
    const cards = Array.from(document.querySelectorAll('div.tf-product.clearfix')) as HTMLElement[];
    return {
      url: location.href,
      totalCards: cards.length,
      firstCardHtml: cards[0]?.outerHTML.slice(0, 3000) ?? null,
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await b.close();
}
main().catch(e => { console.error(e); process.exit(1); });
