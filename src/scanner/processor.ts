/**
 * Per-listing processing: identify, match catalog, create opportunities.
 *
 * Three-stage identification: extract → match → confirm → opportunity.
 */

import { eq, and } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { listingItems, opportunities, products } from "../db/schema";
import type { LlmClient } from "./helpers";
import type { RawListing } from "../sources/IMarketplaceAdapter";
import { upsertListing, getMarketPrice } from "./helpers";
import { extractItems, matchCandidates, confirmMatches } from "./identifier";
import { log, hit, verify, skip } from "@/lib/logger";
import { embeddingRepo } from "@/db/repos/EmbeddingRepo";

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
  const storedListing = upsertListing(db, listing);

  // Embed the listing (skip if already embedded — embedding doesn't change with price)
  try {
    const listingText = `${listing.title} ${listing.description || ""}`.trim();
    const ollamaUrl = process.env.OLLAMA_URL || "http://battleaxe:11434";
    await embeddingRepo.getOrCompute("listing", String(storedListing.id), listingText, ollamaUrl);
  } catch {
    // Non-critical
  }

  // Fast path for PriceCharting offers (product ID already known)
  const pcProductId = (listing.extra ?? {})["pc_product_id"] as string | undefined;
  if (pcProductId) {
    log("processor", `fast path: known PriceCharting product id=${pcProductId}`);
    return processKnownProduct(db, listing, pcProductId, minProfit, minMargin);
  }

  // Check if we already identified this listing (skip LLM if so)
  const existingItems = db
    .select({
      productId: listingItems.productId,
      condition: listingItems.condition,
      confidence: listingItems.confidence,
      confirmed: listingItems.confirmed,
    })
    .from(listingItems)
    .where(eq(listingItems.listingId, storedListing.id))
    .all();

  if (existingItems.length > 0) {
    // Already identified — skip LLM, just re-evaluate opportunities at current prices
    const confirmedItems = existingItems.filter((i) => i.confirmed);
    if (!confirmedItems.length) {
      skip("processor", `already identified (no matches): "${titleShort}"`);
      return 0;
    }

    log("processor", `skip LLM (${confirmedItems.length} known match(es)): "${titleShort}"`);
    let nOpps = 0;
    const confirmedCount = confirmedItems.length;
    const totalItemCount = existingItems.length;

    for (const item of confirmedItems) {
      let condPrice = getMarketPrice(db, item.productId, item.condition);
      if (!condPrice || condPrice <= 0) continue;

      // Conservative: listing_price / confirmed_items (floor)
      const conservativeCost = listing.price_usd / confirmedCount;
      const profit = condPrice * 0.85 - conservativeCost - 5;
      const margin = conservativeCost > 0 ? profit / conservativeCost : 0;

      // Potential: listing_price / total_extracted_items (ceiling)
      const potentialCost = listing.price_usd / totalItemCount;
      const potentialProfit = condPrice * 0.85 - potentialCost - 5;
      const potentialMargin = potentialCost > 0 ? potentialProfit / potentialCost : 0;

      if (profit < minProfit || margin < minMargin) continue;

      // Upsert opportunity
      const existingOpp = db
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(and(eq(opportunities.listingId, storedListing.id), eq(opportunities.productId, item.productId)))
        .limit(1)
        .all()[0];

      if (existingOpp) {
        db.update(opportunities)
          .set({
            listingPriceUsd: conservativeCost,
            marketPriceUsd: condPrice,
            profitUsd: Math.round(profit * 100) / 100,
            marginPct: Math.round(margin * 10000) / 10000,
            potentialProfitUsd: Math.round(potentialProfit * 100) / 100,
            potentialMarginPct: Math.round(potentialMargin * 10000) / 10000,
          })
          .where(eq(opportunities.id, existingOpp.id))
          .run();
      } else {
        const flags: string[] = [];
        if ((listing.num_bids ?? 0) > 0) flags.push("auction_may_increase");
        if (margin >= 2.0) flags.push("verify_authenticity");

        db.insert(opportunities).values({
          listingId: storedListing.id,
          productId: item.productId,
          listingPriceUsd: conservativeCost,
          marketPriceUsd: condPrice,
          marketPriceSource: "pricecharting",
          marketPriceCondition: item.condition,
          profitUsd: Math.round(profit * 100) / 100,
          marginPct: Math.round(margin * 10000) / 10000,
          potentialProfitUsd: Math.round(potentialProfit * 100) / 100,
          potentialMarginPct: Math.round(potentialMargin * 10000) / 10000,
          confidence: item.confidence,
          flags,
          status: "new",
          foundAt: new Date().toISOString(),
        }).run();
        nOpps++;
      }
    }

    return nOpps;
  }

  // New listing — full three-stage: extract → match → confirm
  log("processor", `three-stage path: extract → match → confirm`);

  // Stage 1: Extract items from listing
  const extracted = await extractItems(listing, llm, db);
  if (!extracted.length) {
    skip("processor", `no items extracted from "${titleShort}"`);
    return 0;
  }

  // Stage 2: Match candidates from catalog
  const candidates = await matchCandidates(extracted, db);

  // Stage 3: LLM confirms
  const confirmed = await confirmMatches(extracted, candidates, llm, db, listing.price_usd, listing.marketplace_id);

  // Get the DB listing for storing items
  const dbListing = upsertListing(db, listing, extracted.length > 1);

  // Store ALL extracted items — confirmed AND rejected
  for (let i = 0; i < extracted.length; i++) {
    const item = extracted[i];
    const match = confirmed[i];
    const topCandidate = candidates.get(i)?.[0];

    if (match) {
      // Confirmed match — store with product link
      db.insert(listingItems).values({
        listingId: dbListing.id,
        productId: match.productId,
        condition: match.condition,
        conditionDetails: match.details,
        estimatedValueUsd: match.marketPrice,
        confidence: match.confidence,
        confirmed: true,
        rawExtraction: { name: item.name, productType: item.productType, platform: item.platform, condition: item.condition, metadata: item.metadata },
      }).onConflictDoNothing().run();

      // Embed this product if not already embedded (so future scans find it)
      try {
        const text = `${match.title} ${match.platform}`;
        const ollamaUrl = process.env.OLLAMA_URL || "http://battleaxe:11434";
        await embeddingRepo.getOrCompute("product", match.productId, text, ollamaUrl);
        log("processor", `embedded new product: ${match.title}`);
      } catch {
        // Non-critical — embedding will be generated in next batch job
      }
    } else if (topCandidate) {
      // Rejected but had a candidate — store for review
      db.insert(listingItems).values({
        listingId: dbListing.id,
        productId: topCandidate.productId,
        condition: item.condition,
        conditionDetails: item.metadata,
        estimatedValueUsd: topCandidate.loosePrice,
        confidence: topCandidate.score,
        confirmed: false,
        rawExtraction: { name: item.name, productType: item.productType, platform: item.platform, condition: item.condition, metadata: item.metadata, rejected: true },
      }).onConflictDoNothing().run();
    }
  }

  // Create opportunities for confirmed matches above threshold
  const matches = confirmed.filter((m): m is NonNullable<typeof m> => m !== null);
  if (!matches.length) {
    skip("processor", `no confirmed matches for "${titleShort}"`);
    return 0;
  }

  log("processor", `${matches.length} confirmed match(es) for "${titleShort}"`);
  let nOpps = 0;
  const confirmedCount = matches.length;
  const totalExtracted = extracted.length;

  for (const match of matches) {
    let condPrice = getMarketPrice(db, match.productId, match.condition);
    if (condPrice === null) condPrice = match.marketPrice;
    if (condPrice === null || condPrice <= 0) {
      skip("processor", `no market price for ${match.title} [${match.condition}]`);
      continue;
    }

    // Conservative: listing_price / confirmed_items (floor — what we can prove)
    const conservativeCost = listing.price_usd / confirmedCount;
    const profit = condPrice * 0.85 - conservativeCost - 5;
    const margin = conservativeCost > 0 ? profit / conservativeCost : 0;

    // Potential: listing_price / total_extracted_items (ceiling — if everything has value)
    const potentialCost = listing.price_usd / totalExtracted;
    const potentialProfit = condPrice * 0.85 - potentialCost - 5;
    const potentialMargin = potentialCost > 0 ? potentialProfit / potentialCost : 0;

    if (profit < minProfit || margin < minMargin) {
      skip("processor", `below threshold: ${match.title} profit=$${profit.toFixed(2)} margin=${(margin * 100).toFixed(0)}% (min $${minProfit}/${(minMargin * 100).toFixed(0)}%)`);
      continue;
    }

    const flags: string[] = [];
    if ((listing.num_bids ?? 0) > 0) flags.push("auction_may_increase");
    if (margin >= 2.0) flags.push("verify_authenticity");

    const inserted = db.insert(opportunities)
      .values({
        listingId: dbListing.id,
        productId: match.productId,
        listingPriceUsd: conservativeCost,
        marketPriceUsd: condPrice,
        marketPriceSource: "pricecharting",
        marketPriceCondition: match.condition,
        profitUsd: Math.round(profit * 100) / 100,
        marginPct: Math.round(margin * 10000) / 10000,
        potentialProfitUsd: Math.round(potentialProfit * 100) / 100,
        potentialMarginPct: Math.round(potentialMargin * 10000) / 10000,
        confidence: match.confidence,
        flags,
        status: "new",
        foundAt: new Date().toISOString(),
      })
      .onConflictDoNothing()
      .run();

    if (inserted.changes > 0) {
      nOpps++;
    }

    const lotTag = confirmedCount > 1 ? ` (1/${confirmedCount} in lot)` : "";
    const bids = listing.num_bids ? ` (${listing.num_bids} bids)` : "";
    const dealMsg = `${match.title} [${match.condition}] @ $${conservativeCost.toFixed(2)}${bids}${lotTag} -> $${profit.toFixed(2)} profit (${(margin * 100).toFixed(0)}%)`;
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
