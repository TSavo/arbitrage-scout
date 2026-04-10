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
import { extractItems, matchCandidates, confirmMatches, identifyAndMatch } from "./identifier";
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

  // Three-stage: extract → match → confirm
  log("processor", `three-stage path: extract → match → confirm`);

  // Stage 1: Extract items from listing
  const extracted = await extractItems(listing, llm, db);
  if (!extracted.length) {
    skip("processor", `no items extracted from "${titleShort}"`);
    return 0;
  }

  // Stage 2: Match candidates from catalog
  const candidates = matchCandidates(extracted, db);

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
      }).run();

      // Embed this product if not already embedded (so future scans find it)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sqlite = (db as any).session?.client ?? (db as any)._session?.client;
        if (sqlite) {
          const { initEmbeddingCache, getOrComputeEmbedding } = require("../db/embedding_cache");
          initEmbeddingCache(sqlite);
          const vec = require("sqlite-vec");
          vec.load(sqlite);
          // Check if product already has an embedding
          const existing = sqlite.prepare(
            "SELECT COUNT(*) as c FROM product_embeddings WHERE product_id = ?"
          ).get(match.productId) as { c: number };
          if (existing.c === 0) {
            const text = `${match.title} ${match.platform}`;
            const embedding = getOrComputeEmbedding(sqlite, text);
            if (embedding) {
              const buf = Buffer.alloc(embedding.length * 4);
              for (let k = 0; k < embedding.length; k++) buf.writeFloatLE(embedding[k], k * 4);
              sqlite.prepare(
                "INSERT OR IGNORE INTO product_embeddings(product_id, embedding) VALUES (?, ?)"
              ).run(match.productId, buf);
              log("processor", `embedded new product: ${match.title}`);
            }
          }
        }
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
      }).run();
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
  const itemCount = matches.length;

  for (const match of matches) {
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
