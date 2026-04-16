/**
 * Visit the K&L auction listing URL we have hardcoded and dump:
 *   - Current URL (after any redirects)
 *   - Active filter/facet labels visible on page
 *   - Count of lots shown
 *   - Sample lot titles + their auction dates
 *
 * Compare to what the adapter is currently scraping so we can tell if K&L
 * changed facet IDs.
 */
import { getSharedContext } from "@/lib/shared_browser";

async function main(): Promise<void> {
  const ctx = await getSharedContext();
  const page = ctx.pages()[0] ?? (await ctx.newPage());

  const url = process.argv[2] ??
    "https://www.klwines.com/Products?&filters=sv2_dflt-stock-instock!30$eq$(216)$True$ff-30-(216)--$!88$eq$1$True$ff-88-1--$&orderBy=60%20asc,search.score()%20desc,74%20asc";

  console.log(`→ ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.waitForTimeout(2_500);

  const info = (await page.evaluate(`(() => {
    const text = document.body.innerText;
    // Active filter chips are often labeled "Active Filters" or shown as pills.
    const chips = Array.from(document.querySelectorAll(
      ".active-filter, .filter-chip, [class*=active], [class*=Filter]"
    )).slice(0, 20).map((el) => el.innerText.trim()).filter(Boolean);
    // Breadcrumb / category label
    const crumbs = Array.from(document.querySelectorAll(
      "h1, h2, .breadcrumb, [class*=crumb], [class*=Title]"
    )).slice(0, 8).map((el) => el.innerText.trim()).filter((t) => t.length < 200);
    // First few lot titles
    const lots = Array.from(document.querySelectorAll(
      ".tf-product-card, .tf-auction-card, .product-card, [class*=product-card]"
    )).slice(0, 5).map((el) => el.innerText.trim().split("\\n").slice(0, 3).join(" | "));
    // Total count shown on page
    const countMatch = text.match(/(\\d[\\d,]*)\\s+(?:results?|items?|lots?|products?)/i);
    // Auction date/status fragments anywhere on page
    const auctionBits = Array.from(text.matchAll(/(?:End(?:ing|s)|Auction\\s+Ends|Hammer|Starts)[^\\n]{0,60}/gi))
      .slice(0, 5)
      .map((m) => m[0]);
    return {
      finalUrl: location.href,
      crumbs,
      chips,
      lots,
      countMatch: countMatch ? countMatch[0] : null,
      auctionBits,
    };
  })()`)) as Record<string, unknown>;

  console.log("\n── page info ──");
  console.log("finalUrl:", info.finalUrl);
  console.log("countMatch:", info.countMatch);
  console.log("\ncrumbs / titles:");
  for (const c of info.crumbs as string[]) console.log("  " + c);
  console.log("\nactive chips:");
  for (const c of info.chips as string[]) console.log("  " + c);
  console.log("\nsample lots:");
  for (const l of info.lots as string[]) console.log("  " + l);
  console.log("\nauction date bits:");
  for (const b of info.auctionBits as string[]) console.log("  " + b);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
