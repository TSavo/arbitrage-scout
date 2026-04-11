#!/usr/bin/env npx tsx
/**
 * CLI entry point for stock and scan commands.
 * Usage:
 *   npx tsx src/cli.ts stock
 *   npx tsx src/cli.ts scan
 */

import { section, log } from "./lib/logger";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env.local
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
    section("PLATFORMS — Refreshing platform stats");
    const Database = require("better-sqlite3");
    const dbPath = process.env.DB_PATH || "data/scout-v2.db";
    const sqlite = new Database(dbPath);

    // Refresh the cached platform_stats table (fast — one aggregate query)
    log("cli", "refreshing platform_stats...");
    const t0 = Date.now();
    sqlite.exec("DROP TABLE IF EXISTS platform_stats");
    sqlite.exec(`CREATE TABLE platform_stats (
      platform TEXT PRIMARY KEY, product_type_id TEXT, product_count INTEGER,
      avg_loose REAL, avg_cib REAL, cib_to_loose_ratio REAL,
      total_volume INTEGER, avg_volume REAL,
      pct_above_50 REAL, pct_above_100 REAL, computed_at TEXT
    )`);
    sqlite.exec(`
      INSERT INTO platform_stats
      SELECT p.platform, p.product_type_id,
        COUNT(DISTINCT p.id), ROUND(AVG(pp.price_usd), 2), 0, 0,
        SUM(p.sales_volume), ROUND(AVG(p.sales_volume), 1),
        ROUND(SUM(CASE WHEN pp.price_usd >= 50 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1),
        ROUND(SUM(CASE WHEN pp.price_usd >= 100 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 1),
        datetime('now')
      FROM products p
      JOIN price_points pp ON pp.product_id = p.id AND pp.condition = 'loose' AND pp.price_usd > 0
      GROUP BY p.platform, p.product_type_id
      HAVING COUNT(DISTINCT p.id) >= 20
    `);
    const count = (sqlite.prepare("SELECT COUNT(*) as c FROM platform_stats").get() as {c: number}).c;
    log("cli", `${count} platforms refreshed in ${Date.now() - t0}ms`);

    // Show top undervalued
    const top = sqlite.prepare(`
      SELECT * FROM platform_stats
      WHERE product_type_id = 'retro_game' AND product_count >= 30
      ORDER BY avg_volume DESC LIMIT 15
    `).all() as any[];
    section("TOP RETRO PLATFORMS BY ACTIVITY");
    for (const p of top) {
      log("cli", `  ${(p.platform || '?').padEnd(28)} games=${String(p.product_count).padStart(5)}  avg$${(p.avg_loose || 0).toFixed(0).padStart(5)}  vol=${Math.round(p.avg_volume || 0).toString().padStart(5)}  >$50=${(p.pct_above_50 || 0).toFixed(0)}%  >$100=${(p.pct_above_100 || 0).toFixed(0)}%`);
    }
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
