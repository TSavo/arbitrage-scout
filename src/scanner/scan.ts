/**
 * Phase 2: Scan all configured marketplaces for deals.
 *
 * For each marketplace:
 *   1. Run discovery queries (broad searches)
 *   2. LLM identifies products in each listing
 *   3. Match against catalog
 *   4. Compare price to market value
 *   5. Create Opportunity rows for deals
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { resolve } from "path";
import * as schema from "../db/schema";
import { marketplaces } from "../db/schema";
import { eq } from "drizzle-orm";
import type { IMarketplaceAdapter, RawListing } from "../sources/IMarketplaceAdapter";
import { cfg, startScanLog, finishScanLog, buildLlm } from "./helpers";
import { processListing } from "./processor";
import { log, section, progress, skip, error } from "@/lib/logger";

type Config = Record<string, unknown>;

/**
 * Build the Drizzle db instance for the configured path.
 * Seeds marketplaces if they don't exist.
 */
function openDb(dbPath: string) {
  const sqlite = new Database(resolve(dbPath));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // Initialize embedding cache table
  const { initEmbeddingCache } = require("../db/embedding_cache");
  initEmbeddingCache(sqlite);

  const db = drizzle(sqlite, { schema });
  return { db, sqlite };
}

/**
 * Seed default marketplaces if they don't exist.
 */
function seedMarketplaces(
  db: ReturnType<typeof drizzle<typeof schema>>,
) {
  const defaults: (typeof marketplaces.$inferInsert)[] = [
    { id: "ebay", name: "eBay", baseUrl: "https://www.ebay.com", supportsApi: true },
    { id: "pricecharting", name: "PriceCharting", baseUrl: "https://www.pricecharting.com", supportsApi: true },
    { id: "shopgoodwill", name: "ShopGoodwill", baseUrl: "https://shopgoodwill.com", supportsApi: true },
    { id: "hibid", name: "HiBid", baseUrl: "https://hibid.com", supportsApi: true },
    { id: "mercari", name: "Mercari", baseUrl: "https://www.mercari.com", supportsApi: false },
  ];
  for (const mp of defaults) {
    const existing = db
      .select({ id: marketplaces.id })
      .from(marketplaces)
      .where(eq(marketplaces.id, mp.id))
      .limit(1)
      .all();
    if (!existing.length) {
      db.insert(marketplaces).values(mp).run();
    }
  }
}

/**
 * Scan all configured marketplaces for deals.
 * Returns total opportunities found.
 */
export async function runScan(
  config: Config,
  adapters: IMarketplaceAdapter[],
): Promise<number> {
  const dbPath = cfg(config, "database", "path", "data/scout.db");
  const alertCfg = (config["alerts"] ?? {}) as Record<string, unknown>;
  const normCfg = (config["normalizer"] ?? {}) as Record<string, unknown>;

  const minProfit = typeof alertCfg["min_profit_usd"] === "number"
    ? alertCfg["min_profit_usd"]
    : 25;
  const minMargin =
    (typeof alertCfg["min_margin_pct"] === "number"
      ? alertCfg["min_margin_pct"]
      : 30) / 100;

  const { db } = openDb(dbPath);
  seedMarketplaces(db);

  const llm = buildLlm(normCfg);

  let totalOpportunities = 0;

  for (const adapter of adapters) {
    if (!adapter.isAvailable()) {
      skip("scan", `${adapter.marketplace_id}: adapter unavailable, skipping`);
      continue;
    }

    section(`${adapter.marketplace_id.toUpperCase()} SCAN`);

    // Start scan log
    const scanLogId = startScanLog(db, adapter.marketplace_id);

    // Discover inventory
    const queries = adapter.discoveryQueries();
    log("scan", `${adapter.marketplace_id}: running ${queries.length} discovery queries`);
    const allListings: RawListing[] = [];
    const seenIds = new Set<string>();

    for (let qi = 0; qi < queries.length; qi++) {
      const query = queries[qi];
      log("scan", `query [${qi + 1}/${queries.length}]: "${query}"`);
      const results = await adapter.search(query, { limit: 40 });
      let newThisQuery = 0;
      for (const listing of results) {
        if (!seenIds.has(listing.listing_id)) {
          seenIds.add(listing.listing_id);
          allListings.push(listing);
          newThisQuery++;
        }
      }
      log("scan", `  → ${results.length} results, ${newThisQuery} new unique listings (${allListings.length} total)`);
      if (!adapter.isAvailable()) {
        error("scan", `${adapter.marketplace_id}: rate limit detected after query ${qi + 1}/${queries.length}`);
        break; // rate limited
      }
    }

    if (!allListings.length) {
      log("scan", `${adapter.marketplace_id}: 0 listings found`);
      finishScanLog(db, scanLogId, queries.length, 0, 0, !adapter.isAvailable());
      continue;
    }

    log("scan", `${adapter.marketplace_id}: ${allListings.length} unique listings from ${queries.length} queries — processing...`);

    // Process each listing: identify → match → price → opportunity
    let nOpps = 0;
    for (let i = 0; i < allListings.length; i++) {
      const listing = allListings[i];
      progress(i + 1, allListings.length, `${adapter.marketplace_id} listings`);
      const opps = await processListing(db, llm, listing, minProfit, minMargin);
      nOpps += opps;
    }

    const rateLimited = !adapter.isAvailable();
    finishScanLog(
      db,
      scanLogId,
      queries.length,
      allListings.length,
      nOpps,
      rateLimited,
    );
    totalOpportunities += nOpps;

    log("scan", `${adapter.marketplace_id} summary: ${queries.length} queries, ${allListings.length} listings, ${nOpps} opportunities${rateLimited ? " [RATE LIMITED]" : ""}`);

    if ("close" in adapter && typeof (adapter as { close?: () => void }).close === "function") {
      (adapter as { close: () => void }).close();
    }
  }

  section("SCAN COMPLETE");
  log("scan", `total opportunities found: ${totalOpportunities}`);
  return totalOpportunities;
}
