/**
 * Per-listing processing: identify, match catalog, create opportunities.
 *
 * Three-stage identification: extract → match → confirm → opportunity.
 */

import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { listingItems, opportunities, products } from "../db/schema";
import type { LlmClient } from "./helpers";
import type { RawListing } from "../sources/IMarketplaceAdapter";
import { upsertListing, getMarketPrice } from "./helpers";
import { identifyAndMatch } from "./identifier";
import { log, hit, verify, skip } from "@/lib/logger";

export type Db = BetterSQLite3Database<typeof schema>;

/**
 * Three-stage identification: extract → match → confirm → opportunity.
 *
 * Returns number of opportunities created.
 */
export async function processListing(
  db: Db,
  llm: LlmClient | null,
  listing: RawListing,
  minProfit: number,
  minMargin: number,
): Promise<number> {
  const titleShort = listing.title.length > 60 ? listing.title.slice(0, 57) + "..." : listing.title;
  log("processor", `processing: "${titleShort}" @ $${listing.price_usd.toFixed(2)} [${listing.marketplace_id}/${listing.listing_id}]`);

  // Store every listing we see, regardless of whether it's a deal
  upsertListing(db, listing);

  // Fast path for PriceCharting offers (product ID already known)
  const pcProductId = (listing.extra ?? {})["pc_product_id"] as string | undefined;
  if (pcProductId) {
    log("processor", `fast path: known PriceCharting product id=${pcProductId}`);
    return processKnownProduct(db, listing, pcProductId, minProfit, minMargin);
  }

  // Three-stage: extract items → FTS5 match catalog → LLM confirms
  log("processor", `three-stage path: extract → match → confirm`);
  const matches = await identifyAndMatch(listing, llm, db);
  if (!matches.length) {
    skip("processor", `no confirmed matches for "${titleShort}"`);
    return 0;
  }

  log("processor", `${matches.length} confirmed match(es) for "${titleShort}"`);
  let nOpps = 0;
  const itemCount = matches.length;

  for (const match of matches) {
    // Get condition-matched price
    let condPrice = getMarketPrice(db, match.productId, match.condition);
    if (condPrice === null) condPrice = match.marketPrice;
    if (condPrice === null || condPrice <= 0) {
      skip("processor", `no market price for ${match.title} [${match.condition}]`);
      continue;
    }

    const perItemCost = listing.price_usd / itemCount;
    const profit = condPrice * 0.85 - perItemCost - 5;
    const margin = perItemCost > 0 ? profit / perItemCost : 0;

    if (profit < minProfit || margin < minMargin) {
      skip("processor", `below threshold: ${match.title} profit=$${profit.toFixed(2)} margin=${(margin * 100).toFixed(0)}% (min $${minProfit}/${(minMargin * 100).toFixed(0)}%)`);
      continue;
    }

    const dbListing = upsertListing(db, listing, itemCount > 1);

    db.insert(listingItems)
      .values({
        listingId: dbListing.id,
        productId: match.productId,
        condition: match.condition,
        conditionDetails: match.details,
        estimatedValueUsd: condPrice,
        confidence: match.confidence,
      })
      .run();

    const flags: string[] = [];
    if ((listing.num_bids ?? 0) > 0) flags.push("auction_may_increase");
    if (margin >= 2.0) flags.push("verify_authenticity");

    db.insert(opportunities)
      .values({
        listingId: dbListing.id,
        productId: match.productId,
        listingPriceUsd: perItemCost,
        marketPriceUsd: condPrice,
        marketPriceSource: "pricecharting",
        marketPriceCondition: match.condition,
        profitUsd: Math.round(profit * 100) / 100,
        marginPct: Math.round(margin * 10000) / 10000,
        confidence: match.confidence,
        flags,
        status: "new",
        foundAt: new Date().toISOString(),
      })
      .run();

    nOpps++;

    const lotTag = itemCount > 1 ? ` (1/${itemCount} in lot)` : "";
    const bids = listing.num_bids ? ` (${listing.num_bids} bids)` : "";
    const dealMsg = `${match.title} [${match.condition}] @ $${perItemCost.toFixed(2)}${bids}${lotTag} -> $${profit.toFixed(2)} profit (${(margin * 100).toFixed(0)}%)`;
    if (margin >= 2.0) {
      verify("processor", dealMsg);
    } else {
      hit("processor", dealMsg);
    }
  }

  return nOpps;
}

/**
 * Fast path for PriceCharting marketplace — product ID is already known.
 */
function processKnownProduct(
  db: Db,
  listing: RawListing,
  pcProductId: string,
  minProfit: number,
  minMargin: number,
): number {
  const include = ((listing.extra ?? {})["include"] as string) ?? "";
  const condition = include.toLowerCase().includes("only") ? "loose" : "cib";

  const market = getMarketPrice(db, pcProductId, condition);
  if (market === null || market <= 0) {
    skip("processor", `fast path: no market price for pc_product_id=${pcProductId} [${condition}]`);
    return 0;
  }

  const cost = listing.price_usd;
  const profit = market * 0.85 - cost - 5;
  const margin = cost > 0 ? profit / cost : 0;

  if (profit < minProfit || margin < minMargin) {
    skip("processor", `fast path: below threshold pc_product_id=${pcProductId} profit=$${profit.toFixed(2)} margin=${(margin * 100).toFixed(0)}%`);
    return 0;
  }

  const dbListing = upsertListing(db, listing);

  db.insert(opportunities)
    .values({
      listingId: dbListing.id,
      productId: pcProductId,
      listingPriceUsd: cost,
      marketPriceUsd: market,
      marketPriceSource: "pricecharting",
      marketPriceCondition: condition,
      profitUsd: Math.round(profit * 100) / 100,
      marginPct: Math.round(margin * 10000) / 10000,
      confidence: 0.9,
      flags: [],
      status: "new",
      foundAt: new Date().toISOString(),
    })
    .run();

  const product = db
    .select({ title: products.title })
    .from(products)
    .where(eq(products.id, pcProductId))
    .limit(1)
    .all()[0];

  const name = product?.title ?? listing.title;
  hit("processor", `${name} [${condition}] @ $${cost.toFixed(2)} -> $${profit.toFixed(2)} profit (${(margin * 100).toFixed(0)}%) [${include}]`);

  return 1;
}
