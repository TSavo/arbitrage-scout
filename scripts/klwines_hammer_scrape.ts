/**
 * K&L hammer-price scraper — walks every active klwines auction listing,
 * navigates to the AuctionBidDetail page via the shared CDP Chrome, and
 * for closed lots captures the final bid as a price_point (source=
 * klwines_hammer) and deactivates the listing.
 *
 * Run on hammer day (15th, last day of month) or after. Idempotent via
 * uq_price_points constraint.
 */

import { db } from "@/db/client";
import { listings, pricePoints, listingItems, products } from "@/db/schema";
import { eq, and, like } from "drizzle-orm";
import { getSharedContext } from "@/lib/shared_browser";
import { log, section, error as logError } from "@/lib/logger";
import type { Page } from "playwright";

function humanPause(): number {
  return 2_000 + Math.random() * 2_000;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface AuctionState {
  readonly title: string | null;
  readonly currentBidUsd: number | null;
  readonly bidsCount: number | null;
  readonly closed: boolean;
}

async function readLot(page: Page, url: string): Promise<AuctionState | null> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (e) {
    logError("klwines-hammer", `navigation failed ${url}: ${(e as Error).message.slice(0, 120)}`);
    return null;
  }
  await page.waitForTimeout(600);

  const data = (await page.evaluate(`(() => {
    const txt = document.body.innerText;
    const h1 = document.querySelector("h1, h2, .product-title");
    const title = h1 ? h1.innerText.trim() : null;
    const bidMatch = txt.match(/Current Bid:\\s*\\$([\\d,]+(?:\\.\\d+)?)/i);
    const currentBidUsd = bidMatch ? parseFloat(bidMatch[1].replace(/,/g, "")) : null;
    const bidsMatch = txt.match(/(\\d+)\\s+Bids?/);
    const bidsCount = bidsMatch ? parseInt(bidsMatch[1], 10) : null;
    const closed = /Auction\\s+closed/i.test(txt);
    return { title, currentBidUsd, bidsCount, closed };
  })()`)) as AuctionState;

  return data;
}

async function main(): Promise<void> {
  section("KLWINES HAMMER SCRAPE");

  // Pull all still-active klwines auction listings. After this run, closed
  // ones get is_active=false so subsequent runs shrink the set.
  const rows = await db
    .select({
      id: listings.id,
      sku: listings.marketplaceListingId,
      url: listings.url,
      title: listings.title,
      priceUsd: listings.priceUsd,
    })
    .from(listings)
    .where(
      and(
        eq(listings.marketplaceId, "klwines"),
        eq(listings.isActive, true),
        like(listings.marketplaceListingId, "au-%"),
      ),
    );

  log("klwines-hammer", `${rows.length} active klwines auction listings to check`);

  const ctx = await getSharedContext();
  const page =
    ctx.pages().find((p) => /klwines\.com/.test(p.url())) ??
    (await ctx.newPage());
  await page.bringToFront().catch(() => {});

  let closed = 0;
  let stillOpen = 0;
  let priced = 0;
  let errors = 0;
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  for (const [i, row] of rows.entries()) {
    if (!row.url) { errors++; continue; }
    log("klwines-hammer", `${i + 1}/${rows.length}: ${row.sku} ${row.title.slice(0, 55)}`);

    const state = await readLot(page, row.url);
    if (!state) { errors++; continue; }

    if (!state.closed) {
      stillOpen++;
      log("klwines-hammer", `  → still open (current=$${state.currentBidUsd ?? "?"} bids=${state.bidsCount ?? 0})`);
      await sleep(humanPause());
      continue;
    }

    closed++;

    // Find the linked product via listing_items.
    const itemRow = (await db
      .select({ productId: listingItems.productId })
      .from(listingItems)
      .where(and(eq(listingItems.listingId, row.id), eq(listingItems.confirmed, true)))
      .limit(1))[0];

    if (state.currentBidUsd != null && itemRow) {
      // Look up the product to confirm it exists (defensive).
      const prod = (await db
        .select({ id: products.id })
        .from(products)
        .where(eq(products.id, itemRow.productId))
        .limit(1))[0];

      if (prod) {
        await db
          .insert(pricePoints)
          .values({
            productId: prod.id,
            source: "klwines_hammer",
            condition: "hammer",
            dimensions: { bids: state.bidsCount ?? null, sku: row.sku },
            priceUsd: state.currentBidUsd,
            recordedAt: today,
          })
          .onConflictDoNothing();
        priced++;
        log("klwines-hammer", `  ✓ HAMMER $${state.currentBidUsd.toFixed(2)} (${state.bidsCount ?? 0} bids) → ${prod.id}`);
      }
    } else if (state.currentBidUsd == null) {
      log("klwines-hammer", `  closed but no bid visible — skipping price`);
    } else {
      log("klwines-hammer", `  closed $${state.currentBidUsd.toFixed(2)} but no linked product — skipping price`);
    }

    // Deactivate the listing regardless of product link.
    await db
      .update(listings)
      .set({ isActive: false, lastSeenAt: now })
      .where(eq(listings.id, row.id));

    await sleep(humanPause());
  }

  section("KLWINES HAMMER COMPLETE");
  log(
    "klwines-hammer",
    `total=${rows.length} closed=${closed} priced=${priced} still_open=${stillOpen} errors=${errors}`,
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
