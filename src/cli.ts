#!/usr/bin/env npx tsx
/**
 * CLI entry point for stock and scan commands.
 * Usage:
 *   npx tsx src/cli.ts stock
 *   npx tsx src/cli.ts scan
 */

import { section, log, progress } from "./lib/logger";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local
// NOTE: __dirname works here because we run via tsx, which supports CJS globals.
// If migrating to native ESM, use import.meta.dirname instead.
try {
  const envPath = resolve(__dirname, "../.env.local");
  const envContent = readFileSync(envPath, "utf8");
  for (const line of envContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      const key = trimmed.slice(0, eqIdx);
      const value = trimmed.slice(eqIdx + 1);
      if (!process.env[key]) process.env[key] = value;
    }
  }
} catch {}

async function main() {
  const command = process.argv[2];

  if (command === "stock") {
    section("STOCK — Loading catalog");
    const { runStock } = require("./scanner/stock");
    const config = {
      database: { path: "data/scout-v2.db" },
    };
    const n = await runStock(config);
    log("cli", `stocked ${n} products`);
  } else if (command === "scan") {
    section("SCAN — Searching marketplaces");
    const { runScan } = require("./scanner/scan");
    const { buildAdapters } = require("./sources/registry");
    const config = {
      database: { path: "data/scout-v2.db" },
      ebay: {
        app_id: process.env.EBAY_APP_ID || "",
        cert_id: process.env.EBAY_CERT_ID || "",
      },
      shopgoodwill: {
        username: process.env.SGW_USERNAME || "",
        password: process.env.SGW_PASSWORD || "",
      },
      pricecharting: {
        api_key: process.env.PC_API_KEY || "",
      },
      normalizer: {
        provider: "ollama",
        base_url: process.env.OLLAMA_URL || "http://battleaxe:11434",
        model: process.env.OLLAMA_MODEL || "qwen3:8b",
      },
      alerts: {
        min_profit_usd: 25,
        min_margin_pct: 30,
      },
    };
    const adapters = buildAdapters(config);
    const n = await runScan(config, adapters);
    log("cli", `found ${n} opportunities`);
  } else if (command === "trends") {
    section("TRENDS — Price movement analysis");
    const { detectTrends, platformTrends } = require("./scanner/trends");
    const { risers, fallers } = await detectTrends({
      minChangePct: 10,
      minChangeUsd: 5,
      condition: "loose",
      limit: 25,
    });
    log("cli", `${risers.length} risers, ${fallers.length} fallers`);

    const platforms = await platformTrends();
    if (platforms.length) {
      section("PLATFORM TRENDS");
      for (const p of platforms.slice(0, 15)) {
        const arrow = p.avgChangePct > 0 ? "\u2191" : "\u2193";
        log("cli", `  ${arrow} ${p.avgChangePct.toFixed(1)}%  ${p.platform} (${p.productCount} products)`);
      }
    }
  } else if (command === "arbitrage") {
    section("ARBITRAGE — Cross-marketplace deals");
    const { findCrossMarketplaceDeals } = require("./scanner/arbitrage");
    const deals = await findCrossMarketplaceDeals({
      minProfit: 15,
      minMargin: 0.2,
    });
    log("cli", `${deals.length} cross-marketplace deals`);
  } else if (command === "platforms") {
    section("PLATFORMS — Refreshing platform stats");
    const { productRepo } = require("./db/repos/ProductRepo");

    log("cli", "computing platform stats...");
    const t0 = Date.now();
    const stats = await productRepo.getPlatformStats();
    log("cli", `${stats.length} platforms computed in ${Date.now() - t0}ms`);

    // Show top retro platforms by activity
    const top = stats
      .filter((s: any) => s.productTypeId === "retro_game" && s.productCount >= 30)
      .sort((a: any, b: any) => b.avgVolume - a.avgVolume)
      .slice(0, 15);
    section("TOP RETRO PLATFORMS BY ACTIVITY");
    for (const p of top) {
      log("cli", `  ${(p.platform || '?').padEnd(28)} games=${String(p.productCount).padStart(5)}  avg$${(p.avgLoose || 0).toFixed(0).padStart(5)}  vol=${Math.round(p.avgVolume || 0).toString().padStart(5)}  >$50=${(p.pctAbove50 || 0).toFixed(0)}%  >$100=${(p.pctAbove100 || 0).toFixed(0)}%`);
    }
  } else if (command === "embed") {
    const { runEmbed } = require("./scanner/embed");
    const result = await runEmbed();
    log("cli", `embedded ${result.embedded} products in ${(result.elapsedMs / 1000 / 60).toFixed(1)}m`);
  } else if (command === "verify") {
    const { verifyOpportunityUrls } = require("./scanner/verify");
    const result = await verifyOpportunityUrls();
    log("cli", `verified: ${result.checked} | valid: ${result.valid} | stale: ${result.stale} | errors: ${result.errors}`);
  } else if (command === "seed-types") {
    section("SEED-TYPES — Populating product_type_fields");
    const { seedProductTypes } = require("./db/seed_product_types");
    const result = await seedProductTypes();
    log("cli", `seeded ${result.types} types, ${result.fields} fields, ${result.enumValues} enum values`);
  } else if (command === "seed-taxonomy") {
    section("SEED-TAXONOMY — Populating taxonomy_nodes");
    const { seedTaxonomy } = require("./db/seed_taxonomy");
    const result = await seedTaxonomy();
    log(
      "cli",
      `seeded ${result.nodes} nodes, ${result.fields} fields, ${result.enumValues} enum values; linked ${result.productsLinked} products`,
    );
  } else if (command === "seed-from-pricecharting") {
    section("SEED FROM PRICECHARTING — Deriving taxonomy from CSV data");
    const { seedFromPriceCharting } = require("./db/seed_from_pricecharting");
    const result = await seedFromPriceCharting();
    log("cli", `processed ${result.categoriesProcessed} categories`);
    log(
      "cli",
      `created ${result.nodesCreated} nodes, ${result.fieldsCreated} fields, ${result.enumValuesCreated} enum values`,
    );
  } else if (command === "reprocess") {
    section("REPROCESS — Catching products up to current schema version");
    const { reprocessStaleProducts } = require("./pipeline/reprocess");
    const n = await reprocessStaleProducts({ limit: 1000 });
    log("cli", `reprocessed ${n} products`);
  } else if (command === "pipe") {
    section("PIPE — Command pipeline (experimental)");
    const { CommandPipeline } = require("./pipeline");
    const { buildAdapters } = require("./sources/registry");
    const { formatCurrency, formatPercent } = require("./pipeline/utils");
    const { productTypeRepo } = require("./db/repos/ProductTypeRepo");

    log("cli", "loading product type schema...");

    const schema = await productTypeRepo.getAllSchemas();

    log("cli", `loaded ${schema.length} product types`);

    const pipeline = new CommandPipeline({
      extractionBatchSize: 20,
      minProfitUsd: 25,
      minMarginPct: 0.30,
      llmUrl: process.env.OLLAMA_URL || "http://battleaxe:11434",
      llmModel: process.env.OLLAMA_MODEL || "qwen3:8b",
    });

    const emitter = pipeline.getEmitter();

    emitter.on('command.issued', (event: any) => {
      const prefix = event.type.padEnd(10);
      log("pipe", `  [${prefix}] ${event.data.durationMs}ms`);
    });

    emitter.on('opportunity.found', (event: any) => {
      log("pipe", `  + ${formatCurrency(event.data.profit)} (${formatPercent(event.data.margin)})`);
    });

    log("cli", "pipeline ready, loading adapters...");

    const adapters = buildAdapters({
      database: { path: "data/scout-v2.db" },
      ebay: {
        app_id: process.env.EBAY_APP_ID || "",
        cert_id: process.env.EBAY_CERT_ID || "",
      },
      shopgoodwill: {
        username: process.env.SGW_USERNAME || "",
        password: process.env.SGW_PASSWORD || "",
      },
      pricecharting: {
        api_key: process.env.PC_API_KEY || "",
      },
    });

    log("cli", `loaded ${adapters.length} adapters`);
    log("cli", "starting scan...");

    let totalOpportunities = 0;
    let totalListings = 0;

    for (const adapter of adapters) {
      if (!adapter.isAvailable()) {
        log("pipe", `skipping ${adapter.marketplace_id} (unavailable)`);
        continue;
      }

      section(`PIPE: ${adapter.marketplace_id}`);

      const queries = adapter.discoveryQueries().slice(0, 3);
      let adapterOpps = 0;
      let adapterListings = 0;

      for (const query of queries) {
        log("pipe", `  searching: "${query}"`);
        try {
          const listings = await adapter.search(query, { limit: 10 });
          log("cli", `  got ${listings.length} listings`);

          for (const raw of listings) {
            const normalized = {
              marketplaceId: raw.marketplace_id,
              listingId: raw.listing_id,
              title: raw.title,
              priceUsd: raw.price_usd,
              shippingUsd: raw.shipping_usd ?? 0,
              url: raw.url,
              description: raw.description,
              conditionRaw: raw.condition_raw,
              categoryRaw: raw.category_raw,
              imageUrl: raw.image_url,
              seller: raw.seller,
              numBids: raw.num_bids,
              itemCount: raw.item_count,
              endTime: raw.end_time,
              extra: raw.extra,
              scrapedAt: Date.now(),
            };

            try {
              const result = await pipeline.processListing(normalized, schema);
              if (result.opportunities.length > 0) {
                totalOpportunities += result.opportunities.length;
                adapterOpps += result.opportunities.length;
              }
              adapterListings++;
            } catch (err) {
              log("pipe", `  error: ${err}`);
            }
          }
        } catch (err) {
          log("pipe", `  search error: ${err}`);
        }
      }

      totalListings += adapterListings;
      log("cli", `${adapter.marketplace_id}: ${adapterListings} listings, ${adapterOpps} opportunities`);
    }

    const metrics = pipeline.getMetrics();
    section("PIPE COMPLETE");
    log("cli", `total listings: ${totalListings}`);
    log("cli", `total opportunities: ${totalOpportunities}`);
    log("cli", `total commands: ${metrics.commands.length}`);
    log("cli", `total errors: ${metrics.totalErrors}`);
    log("cli", `total time: ${(metrics.totalTimeMs / 1000).toFixed(1)}s`);
  } else {
    console.log("Usage: npx tsx src/cli.ts [stock|scan|trends|arbitrage|platforms|embed|verify|seed-types|seed-taxonomy|seed-from-pricecharting|reprocess|pipe]");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
