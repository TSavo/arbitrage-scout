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

type Config = Record<string, unknown>;

/**
 * Build the Drizzle db instance for the configured path.
 * Seeds marketplaces if they don't exist.
 */
function openDb(dbPath: string) {
  const sqlite = new Database(resolve(dbPath));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
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
      console.log(`\n${adapter.marketplace_id}: unavailable, skipping`);
      continue;
    }

    console.log(`\n${adapter.marketplace_id}`);

    // Start scan log
    const scanLogId = startScanLog(db, adapter.marketplace_id);

    // Discover inventory
    const queries = adapter.discoveryQueries();
    const allListings: RawListing[] = [];
    const seenIds = new Set<string>();

    for (const query of queries) {
      const results = await adapter.search(query, { limit: 40 });
      for (const listing of results) {
        if (!seenIds.has(listing.listing_id)) {
          seenIds.add(listing.listing_id);
          allListings.push(listing);
        }
      }
      if (!adapter.isAvailable()) break; // rate limited
    }

    if (!allListings.length) {
      console.log(`  0 listings found`);
      finishScanLog(db, scanLogId, queries.length, 0, 0, !adapter.isAvailable());
      continue;
    }

    console.log(
      `  ${allListings.length} unique listings from ${queries.length} queries`,
    );

    // Process each listing: identify → match → price → opportunity
    let nOpps = 0;
    for (let i = 0; i < allListings.length; i++) {
      const listing = allListings[i];
      process.stdout.write(
        `\r  [${i + 1}/${allListings.length}] ${adapter.marketplace_id}...`,
      );
      const opps = await processListing(db, llm, listing, minProfit, minMargin);
      nOpps += opps;
    }
    process.stdout.write("\n");

    finishScanLog(
      db,
      scanLogId,
      queries.length,
      allListings.length,
      nOpps,
      !adapter.isAvailable(),
    );
    totalOpportunities += nOpps;

    if ("close" in adapter && typeof (adapter as { close?: () => void }).close === "function") {
      (adapter as { close: () => void }).close();
    }
  }

  console.log(`\n${totalOpportunities} total opportunities\n`);
  return totalOpportunities;
}
