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
import type {
  IMarketplaceAdapter,
  RawListing,
} from "../sources/IMarketplaceAdapter";
import { searchAsStream } from "../sources/IMarketplaceAdapter";

/**
 * Adapter's own queries run strictly serially — each adapter has limited
 * browser/session resources, and firing every discovery query concurrently
 * caused Playwright page.goto timeouts under load. Between adapters, the
 * scan pipeline's merge() keeps parallelism.
 */
async function* serialQueryStream(
  adapter: IMarketplaceAdapter,
  queries: readonly string[],
): AsyncIterable<RawListing> {
  for (const q of queries) {
    if (!adapter.isAvailable()) break;
    for await (const listing of searchAsStream(adapter, q)) {
      yield listing;
    }
  }
}
import { startScanLog, finishScanLog, buildLlm } from "./helpers";
import { runPipeline } from "@/pipeline/stream/pipeline";
import { merge } from "@/pipeline/stream/parallel";
import { checkWatchlistAlerts } from "./watchlist";
import { log, section, skip, error } from "@/lib/logger";

type Config = Record<string, unknown>;

/**
 * Seed default marketplaces if they don't exist.
 */
async function seedMarketplaces(): Promise<void> {
  const defaults: (typeof marketplaces.$inferInsert)[] = [
    { id: "ebay", name: "eBay", baseUrl: "https://www.ebay.com", supportsApi: true },
    { id: "pricecharting", name: "PriceCharting", baseUrl: "https://www.pricecharting.com", supportsApi: true },
    { id: "shopgoodwill", name: "ShopGoodwill", baseUrl: "https://shopgoodwill.com", supportsApi: true },
    { id: "hibid", name: "HiBid", baseUrl: "https://hibid.com", supportsApi: true },
    { id: "discogs", name: "Discogs", baseUrl: "https://www.discogs.com", supportsApi: true },
    { id: "mercari", name: "Mercari", baseUrl: "https://www.mercari.com", supportsApi: false },
    { id: "klwines", name: "K&L Wines", baseUrl: "https://www.klwines.com", supportsApi: false },
    { id: "bittersandbottles", name: "Bitters & Bottles", baseUrl: "https://www.bittersandbottles.com", supportsApi: true },
    { id: "seelbachs", name: "Seelbach's", baseUrl: "https://seelbachs.com", supportsApi: true },
    { id: "shopsk", name: "ShopSK", baseUrl: "https://shopsk.com", supportsApi: true },
    { id: "woodencork", name: "Wooden Cork", baseUrl: "https://woodencork.com", supportsApi: true },
    { id: "caskcartel", name: "Cask Cartel", baseUrl: "https://www.caskcartel.com", supportsApi: true },
    { id: "whiskybusiness", name: "Whisky Business", baseUrl: "https://whiskybusiness.com", supportsApi: true },
    { id: "flaviar", name: "Flaviar", baseUrl: "https://flaviar.com", supportsApi: true },
    { id: "tcgplayer", name: "TCGPlayer", baseUrl: "https://www.tcgplayer.com", supportsApi: true },
    { id: "liveauctioneers", name: "LiveAuctioneers", baseUrl: "https://www.liveauctioneers.com", supportsApi: true },
    { id: "whatnot", name: "Whatnot", baseUrl: "https://www.whatnot.com", supportsApi: false },
  ];
  for (const mp of defaults) {
    const existing = await db
      .select({ id: marketplaces.id })
      .from(marketplaces)
      .where(eq(marketplaces.id, mp.id))
      .limit(1);
    if (!existing.length) {
      await db.insert(marketplaces).values(mp);
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

  await seedMarketplaces();

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

  // Auto-seed any marketplace row missing for an active adapter. Prevents
  // FK crashes when a new adapter is added before the seed list is updated.
  for (const a of available) {
    const existing = await db
      .select({ id: marketplaces.id })
      .from(marketplaces)
      .where(eq(marketplaces.id, a.marketplace_id))
      .limit(1);
    if (!existing.length) {
      log("scan", `auto-seeding missing marketplace row: ${a.marketplace_id}`);
      await db.insert(marketplaces)
        .values({
          id: a.marketplace_id,
          name: a.marketplace_id,
          baseUrl: "",
          supportsApi: false,
        });
    }
  }

  // Record per-adapter scan log start.
  const scanLogIds = new Map<string, number>();
  for (const a of available) {
    scanLogIds.set(a.marketplace_id, await startScanLog(db, a.marketplace_id));
    section(`${a.marketplace_id.toUpperCase()} SCAN`);
  }

  // One stream per ADAPTER — within it, the adapter's discovery queries
  // run serially (so each adapter only has one Playwright page / API call
  // in flight at a time, avoiding thundering-herd browser launches).
  //
  // Ordering: K&L goes FIRST as a prefix stream so its listings enter the
  // pipeline before other adapters' much-faster output floods the buffer
  // and makes K&L's items wait behind thousands of non-K&L items.
  // Everything else merges in concurrently AFTER K&L finishes.
  const kl = available.find((a) => a.marketplace_id === "klwines");
  const others = available.filter((a) => a.marketplace_id !== "klwines");
  const buildStream = (a: IMarketplaceAdapter): AsyncIterable<RawListing> => {
    const queries = a.discoveryQueries();
    log("scan", `${a.marketplace_id}: ${queries.length} discovery queries`);
    return serialQueryStream(a, queries);
  };
  async function* prefixThenMerge(): AsyncIterable<RawListing> {
    if (kl) {
      log("scan", "running klwines FIRST (prefix stream)");
      for await (const l of buildStream(kl)) yield l;
      log("scan", "klwines complete — merging remaining adapters");
    }
    const otherStreams = others.map(buildStream);
    for await (const l of merge(...otherStreams)) yield l;
  }
  const mergedSource = prefixThenMerge();

  // LLM stage concurrency = size of the provider pool. Each worker picks
  // a free provider when it calls llmPool.generateJson, so N providers
  // means N concurrent classify/extract operations.
  const llmConcurrency =
    llm && "size" in (llm as object) && typeof (llm as unknown as { size: unknown }).size === "number"
      ? (llm as unknown as { size: number }).size
      : 1;
  if (llmConcurrency > 1) {
    log("scan", `LLM pool size ${llmConcurrency} — stages scale accordingly`);
  }

  const result = await runPipeline({
    source: mergedSource,
    llm: llm ?? undefined,
    llmConcurrency,
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
      await finishScanLog(
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
  const alertCount = await checkWatchlistAlerts();
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
