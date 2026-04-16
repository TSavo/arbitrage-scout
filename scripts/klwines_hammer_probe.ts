/**
 * Probe a closed K&L auction lot and dump what "hammer price" / final bid
 * fields look like on the page. Uses the CDP Chrome at :9222 (which has
 * the logged-in K&L session).
 */
import { getSharedContext } from "@/lib/shared_browser";

async function main(): Promise<void> {
  const ctx = await getSharedContext();
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  const url = process.argv[2] ??
    "https://www.klwines.com/Auction/Bidding/AuctionBidDetail.aspx?sku=1995063";
  console.log(`→ ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1500);

  const data = await page.evaluate(`(() => {
    const pick = (sel) => {
      const el = document.querySelector(sel);
      return el ? el.innerText.trim() : null;
    };
    const txt = document.body.innerText;
    const m = txt.match(/(?:Sold for|Winning Bid|Final Bid|Hammer|Current Bid)[^\\n]*\\$[\\d,]+(?:\\.\\d+)?/gi);
    return {
      title: pick("h1, h2, .product-title"),
      winning_bid: pick(".tf-auction-winning-bid, .winning-bid, [class*=winning]"),
      sold_for: pick(".tf-auction-sold-price, .sold-for, [class*=sold]"),
      current_bid: pick(".tf-auction-current-bid, [class*=current-bid]"),
      end_time: pick(".tf-auction-end-time, [class*=end-time]"),
      status: pick(".auction-status, [class*=status]"),
      regex_matches: m || [],
      raw_snippet: txt.slice(0, 2000),
    };
  })()`) as Record<string, unknown>;

  console.log("\n── extracted ──");
  for (const [k, v] of Object.entries(data)) {
    if (k === "raw_snippet") continue;
    console.log(`${k}: ${v ?? "(null)"}`);
  }
  console.log("\n── raw snippet (first 2KB) ──");
  console.log(data.raw_snippet);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
