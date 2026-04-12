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

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { marketplaces } from "@/db/schema";
import type { IMarketplaceAdapter } from "../sources/IMarketplaceAdapter";
import { searchAsStream } from "../sources/IMarketplaceAdapter";
import { startScanLog, finishScanLog, buildLlm } from "./helpers";
import { runPipeline } from "@/pipeline/stream/pipeline";
import { merge } from "@/pipeline/stream/parallel";
import { checkWatchlistAlerts } from "./watchlist";
import { log, section, skip, error } from "@/lib/logger";

type Config = Record<string, unknown>;

/**
 * Seed default marketplaces if they don't exist.
 */
function seedMarketplaces() {
  const defaults: (typeof marketplaces.$inferInsert)[] = [
    { id: "ebay", name: "eBay", baseUrl: "https://www.ebay.com", supportsApi: true },
    { id: "pricecharting", name: "PriceCharting", baseUrl: "https://www.pricecharting.com", supportsApi: true },
    { id: "shopgoodwill", name: "ShopGoodwill", baseUrl: "https://shopgoodwill.com", supportsApi: true },
    { id: "hibid", name: "HiBid", baseUrl: "https://hibid.com", supportsApi: true },
    { id: "discogs", name: "Discogs", baseUrl: "https://www.discogs.com", supportsApi: true },
    { id: "mercari", name: "Mercari", baseUrl: "https://www.mercari.com", supportsApi: false },
    { id: "klwines", name: "K&L Wines", baseUrl: "https://www.klwines.com", supportsApi: false },
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
  const alertCfg = (config["alerts"] ?? {}) as Record<string, unknown>;
  const normCfg = (config["normalizer"] ?? {}) as Record<string, unknown>;

  const minProfit = typeof alertCfg["min_profit_usd"] === "number"
    ? alertCfg["min_profit_usd"]
    : 25;
  const minMargin =
    (typeof alertCfg["min_margin_pct"] === "number"
      ? alertCfg["min_margin_pct"]
      : 30) / 100;

  seedMarketplaces();

  const llm = buildLlm(normCfg);
  const ollamaUrl =
    (normCfg["base_url"] as string) ??
    process.env.OLLAMA_URL ??
    "http://battleaxe:11434";

  // Every adapter discovery query becomes its own stream; merge them so the
  // pipeline sees a single continuous flow of listings from all sources. The
  // streaming pipeline keeps every stage working concurrently — scraper, LLM,
  // persist — so first results flow while later ones are still being fetched.
  const available = adapters.filter((a) => {
    if (!a.isAvailable()) {
      skip("scan", `${a.marketplace_id}: adapter unavailable, skipping`);
      return false;
    }
    return true;
  });

  if (available.length === 0) {
    section("SCAN COMPLETE");
    log("scan", "no adapters available");
    return 0;
  }

  // Record per-adapter scan log start.
  const scanLogIds = new Map<string, number>();
  for (const a of available) {
    scanLogIds.set(a.marketplace_id, startScanLog(db, a.marketplace_id));
    section(`${a.marketplace_id.toUpperCase()} SCAN`);
  }

  // Build one source stream per (adapter, query) and merge them all.
  const sourceStreams: Array<AsyncIterable<any>> = [];
  for (const a of available) {
    const queries = a.discoveryQueries();
    log("scan", `${a.marketplace_id}: ${queries.length} discovery queries`);
    for (const q of queries) {
      sourceStreams.push(searchAsStream(a, q));
    }
  }
  const mergedSource = merge(...sourceStreams);

  const result = await runPipeline({
    source: mergedSource,
    llm: llm ?? undefined,
    thresholds: {
      minProfitUsd: minProfit,
      minMarginPct: minMargin,
      feeRate: 0.15,
      shippingOutUsd: 5,
    },
    ollamaUrl,
  });

  // Close any adapters that hold resources (Playwright browsers, etc.).
  for (const a of available) {
    if ("close" in a && typeof (a as any).close === "function") {
      await (a as any).close();
    }
    const scanLogId = scanLogIds.get(a.marketplace_id);
    if (scanLogId) {
      // We don't break down per-adapter counts from the merged stream; log the
      // overall scan totals against each adapter's row. Good enough for now.
      finishScanLog(
        db,
        scanLogId,
        a.discoveryQueries().length,
        result.total,
        result.opportunitiesFound,
        !a.isAvailable(),
      );
    }
  }

  section("WATCHLIST ALERTS");
  const alertCount = checkWatchlistAlerts();
  log("scan", `watchlist: ${alertCount} new alert(s) triggered`);

  section("SCAN COMPLETE");
  log(
    "scan",
    `total: ${result.total} items (fastPath=${result.fastPath} fullWalk=${result.fullWalk} errored=${result.errored}) opportunities=${result.opportunitiesFound}`,
  );
  if (result.errorsByStage.size > 0) {
    for (const [stage, n] of result.errorsByStage) {
      log("scan", `  errors in ${stage}: ${n}`);
    }
  }
  return result.opportunitiesFound;
}
