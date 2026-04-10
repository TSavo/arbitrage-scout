#!/usr/bin/env npx tsx
/**
 * CLI entry point for stock and scan commands.
 * Usage:
 *   npx tsx src/cli.ts stock
 *   npx tsx src/cli.ts scan
 */

import { section, log } from "./lib/logger";

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
    const Database = require("better-sqlite3");
    const dbPath = process.env.DB_PATH || "data/scout-v2.db";
    const sqlite = new Database(dbPath);
    const { detectTrends, platformTrends } = require("./scanner/trends");
    const { risers, fallers } = detectTrends(sqlite, {
      minChangePct: 10,
      minChangeUsd: 5,
      condition: "loose",
      limit: 25,
    });
    log("cli", `${risers.length} risers, ${fallers.length} fallers`);

    const platforms = platformTrends(sqlite);
    if (platforms.length) {
      section("PLATFORM TRENDS");
      for (const p of platforms.slice(0, 15)) {
        const arrow = p.avgChangePct > 0 ? "↑" : "↓";
        log("cli", `  ${arrow} ${p.avgChangePct.toFixed(1)}%  ${p.platform} (${p.productCount} products)`);
      }
    }
    sqlite.close();
  } else if (command === "arbitrage") {
    section("ARBITRAGE — Cross-marketplace deals");
    const Database = require("better-sqlite3");
    const dbPath = process.env.DB_PATH || "data/scout-v2.db";
    const sqlite = new Database(dbPath);
    const { findCrossMarketplaceDeals } = require("./scanner/arbitrage");
    const deals = findCrossMarketplaceDeals(sqlite, {
      minProfit: 15,
      minMargin: 0.2,
    });
    log("cli", `${deals.length} cross-marketplace deals`);
    sqlite.close();
  } else if (command === "platforms") {
    section("PLATFORMS — Undervalued platform analysis");
    const Database = require("better-sqlite3");
    const dbPath = process.env.DB_PATH || "data/scout-v2.db";
    const sqlite = new Database(dbPath);
    const { findUndervaluedPlatforms } = require("./scanner/platforms");
    findUndervaluedPlatforms(sqlite);
    sqlite.close();
  } else {
    console.log("Usage: npx tsx src/cli.ts [stock|scan|trends|arbitrage|platforms]");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
