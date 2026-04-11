/**
 * Watchlist alert checking — runs at the end of each scan cycle.
 *
 * Finds active watchlist items whose target price threshold is now
 * met by an existing listing, and marks them as triggered.
 */

import { and, eq, isNull, lte, desc, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { watchlistItems, pricePoints, listings, listingItems } from "@/db/schema";
import { log } from "@/lib/logger";

/**
 * Check all active watchlist items against current listings.
 * Returns the number of newly triggered alerts.
 */
export function checkWatchlistAlerts(): number {
  // Step 1: get all active, non-triggered watchlist items
  const candidates = db
    .select({
      id: watchlistItems.id,
      productId: watchlistItems.productId,
      condition: watchlistItems.condition,
      targetPricePct: watchlistItems.targetPricePct,
    })
    .from(watchlistItems)
    .where(
      and(
        eq(watchlistItems.active, true),
        isNull(watchlistItems.triggeredAt),
      ),
    )
    .all();

  if (!candidates.length) {
    log("watchlist", "no active watchlist items to check");
    return 0;
  }

  log("watchlist", `checking ${candidates.length} active watchlist item(s)`);

  const now = new Date().toISOString();
  let triggered = 0;

  for (const c of candidates) {
    // Get latest market price for this product + condition
    const latestPrice = db
      .select({ priceUsd: pricePoints.priceUsd })
      .from(pricePoints)
      .where(
        and(
          eq(pricePoints.productId, c.productId),
          eq(pricePoints.condition, c.condition),
        ),
      )
      .orderBy(desc(pricePoints.recordedAt))
      .limit(1)
      .all();

    const marketPrice = latestPrice[0]?.priceUsd ?? null;

    if (marketPrice === null || marketPrice <= 0) {
      log(
        "watchlist",
        `skip product=${c.productId} [${c.condition}]: no market price`,
      );
      continue;
    }

    const threshold = marketPrice * (1 - c.targetPricePct / 100);

    // Check for a matching listing below threshold
    const match = db
      .select({
        id: listings.id,
        priceUsd: listings.priceUsd,
      })
      .from(listings)
      .innerJoin(listingItems, eq(listingItems.listingId, listings.id))
      .where(
        and(
          eq(listingItems.productId, c.productId),
          eq(listingItems.confirmed, true),
          eq(listings.isActive, true),
          lte(listings.priceUsd, threshold),
        ),
      )
      .limit(1)
      .all();

    if (match.length > 0) {
      db.update(watchlistItems)
        .set({ triggeredAt: now })
        .where(eq(watchlistItems.id, c.id))
        .run();
      triggered++;
      log(
        "watchlist",
        `TRIGGERED id=${c.id} product=${c.productId} [${c.condition}] ` +
          `market=$${marketPrice.toFixed(2)} threshold=$${threshold.toFixed(2)} ` +
          `listing=$${match[0].priceUsd.toFixed(2)}`,
      );
    }
  }

  return triggered;
}
