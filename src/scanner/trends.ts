/**
 * Trend detection: compare today's prices against previous price points.
 * Surfaces products with significant price changes.
 */

import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq, and, desc, sql } from "drizzle-orm";
import * as schema from "../db/schema";
import { products, pricePoints } from "../db/schema";
import { log, section } from "@/lib/logger";

export interface PriceMover {
  productId: string;
  title: string;
  platform: string;
  condition: string;
  previousPrice: number;
  currentPrice: number;
  changeUsd: number;
  changePct: number;
  previousDate: string;
  currentDate: string;
}

/**
 * Find products whose price changed significantly between two dates.
 * Call after loading a fresh PriceCharting CSV.
 */
export function detectTrends(
  sqliteDb: Database.Database,
  opts: {
    minChangePct?: number;
    minChangeUsd?: number;
    condition?: string;
    limit?: number;
    productType?: string;
  } = {},
): { risers: PriceMover[]; fallers: PriceMover[] } {
  const minPct = opts.minChangePct ?? 10;
  const minUsd = opts.minChangeUsd ?? 5;
  const condition = opts.condition ?? "loose";
  const limit = opts.limit ?? 50;

  section("TREND DETECTION");

  // Find the two most recent distinct dates in price_points
  const dates = sqliteDb
    .prepare(
      `SELECT DISTINCT recorded_at FROM price_points
       WHERE condition = ? AND source = 'pricecharting'
       ORDER BY recorded_at DESC LIMIT 2`,
    )
    .all(condition) as { recorded_at: string }[];

  if (dates.length < 2) {
    log("trends", "need at least 2 days of price data — run stock twice");
    return { risers: [], fallers: [] };
  }

  const currentDate = dates[0].recorded_at;
  const previousDate = dates[1].recorded_at;
  log("trends", `comparing ${previousDate} → ${currentDate}`);

  // Find products with price changes
  let typeFilter = "";
  const params: unknown[] = [condition, currentDate, condition, previousDate];
  if (opts.productType) {
    typeFilter = "AND p.product_type_id = ?";
    params.push(opts.productType);
  }

  const movers = sqliteDb
    .prepare(
      `SELECT
         p.id as product_id,
         p.title,
         p.platform,
         pp_old.price_usd as previous_price,
         pp_new.price_usd as current_price,
         (pp_new.price_usd - pp_old.price_usd) as change_usd,
         ((pp_new.price_usd - pp_old.price_usd) / pp_old.price_usd * 100) as change_pct
       FROM products p
       JOIN price_points pp_new ON pp_new.product_id = p.id
         AND pp_new.condition = ? AND pp_new.recorded_at = ?
       JOIN price_points pp_old ON pp_old.product_id = p.id
         AND pp_old.condition = ? AND pp_old.recorded_at = ?
       WHERE pp_old.price_usd > 5
         AND ABS(pp_new.price_usd - pp_old.price_usd) >= ${minUsd}
         AND ABS((pp_new.price_usd - pp_old.price_usd) / pp_old.price_usd * 100) >= ${minPct}
         ${typeFilter}
       ORDER BY change_pct DESC`,
    )
    .all(...params) as Array<{
    product_id: string;
    title: string;
    platform: string;
    previous_price: number;
    current_price: number;
    change_usd: number;
    change_pct: number;
  }>;

  const risers: PriceMover[] = [];
  const fallers: PriceMover[] = [];

  for (const m of movers) {
    const mover: PriceMover = {
      productId: m.product_id,
      title: m.title,
      platform: m.platform,
      condition,
      previousPrice: m.previous_price,
      currentPrice: m.current_price,
      changeUsd: m.change_usd,
      changePct: m.change_pct,
      previousDate,
      currentDate,
    };
    if (m.change_pct > 0) risers.push(mover);
    else fallers.push(mover);
  }

  // Sort risers by % change desc, fallers by % change asc
  risers.sort((a, b) => b.changePct - a.changePct);
  fallers.sort((a, b) => a.changePct - b.changePct);

  log("trends", `${risers.length} risers, ${fallers.length} fallers (>${minPct}% and >$${minUsd})`);

  if (risers.length) {
    log("trends", "top risers:");
    for (const r of risers.slice(0, 10)) {
      log("trends", `  +${r.changePct.toFixed(0)}% (+$${r.changeUsd.toFixed(2)})  $${r.previousPrice.toFixed(2)} → $${r.currentPrice.toFixed(2)}  ${r.title} (${r.platform})`);
    }
  }
  if (fallers.length) {
    log("trends", "top fallers:");
    for (const f of fallers.slice(0, 10)) {
      log("trends", `  ${f.changePct.toFixed(0)}% ($${f.changeUsd.toFixed(2)})  $${f.previousPrice.toFixed(2)} → $${f.currentPrice.toFixed(2)}  ${f.title} (${f.platform})`);
    }
  }

  return {
    risers: risers.slice(0, limit),
    fallers: fallers.slice(0, limit),
  };
}

/**
 * Platform-level trend summary: which consoles are heating up?
 */
export function platformTrends(
  sqliteDb: Database.Database,
  condition = "loose",
): Array<{ platform: string; avgChangePct: number; productCount: number }> {
  const dates = sqliteDb
    .prepare(
      `SELECT DISTINCT recorded_at FROM price_points
       WHERE condition = ? AND source = 'pricecharting'
       ORDER BY recorded_at DESC LIMIT 2`,
    )
    .all(condition) as { recorded_at: string }[];

  if (dates.length < 2) return [];

  const rows = sqliteDb
    .prepare(
      `SELECT
         p.platform,
         AVG((pp_new.price_usd - pp_old.price_usd) / pp_old.price_usd * 100) as avg_change_pct,
         COUNT(*) as product_count
       FROM products p
       JOIN price_points pp_new ON pp_new.product_id = p.id
         AND pp_new.condition = ? AND pp_new.recorded_at = ?
       JOIN price_points pp_old ON pp_old.product_id = p.id
         AND pp_old.condition = ? AND pp_old.recorded_at = ?
       WHERE pp_old.price_usd > 10
       GROUP BY p.platform
       HAVING product_count >= 10
       ORDER BY avg_change_pct DESC`,
    )
    .all(condition, dates[0].recorded_at, condition, dates[1].recorded_at) as Array<{
    platform: string;
    avg_change_pct: number;
    product_count: number;
  }>;

  return rows.map((r) => ({
    platform: r.platform,
    avgChangePct: r.avg_change_pct,
    productCount: r.product_count,
  }));
}
