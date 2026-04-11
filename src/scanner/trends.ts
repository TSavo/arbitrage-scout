/**
 * Trend detection: compare today's prices against previous price points.
 * Surfaces products with significant price changes.
 */

import { pricePointRepo } from "@/db/repos/PricePointRepo";
import { productRepo } from "@/db/repos/ProductRepo";
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
export async function detectTrends(
  opts: {
    minChangePct?: number;
    minChangeUsd?: number;
    condition?: string;
    limit?: number;
    productType?: string;
  } = {},
): Promise<{ risers: PriceMover[]; fallers: PriceMover[] }> {
  const minPct = opts.minChangePct ?? 10;
  const minUsd = opts.minChangeUsd ?? 5;
  const condition = opts.condition ?? "loose";
  const limit = opts.limit ?? 50;

  section("TREND DETECTION");

  // Get price changes between two most recent dates
  const changes = await pricePointRepo.findPriceChanges({
    condition,
    minPriceUsd: 5,
    limit: 10_000, // get all, filter below
  });

  if (changes.length === 0) {
    log("trends", "need at least 2 days of price data — run stock twice");
    return { risers: [], fallers: [] };
  }

  const currentDate = changes[0].newDate;
  const previousDate = changes[0].oldDate;
  log("trends", `comparing ${previousDate} → ${currentDate}`);

  // Build a set of product IDs for type filtering
  let typeProductIds: Set<string> | null = null;
  if (opts.productType) {
    const typeProducts = await productRepo.findByType(opts.productType, { limit: 100_000 });
    typeProductIds = new Set(typeProducts.map((p) => p.id));
  }

  // Look up product details for each change
  const risers: PriceMover[] = [];
  const fallers: PriceMover[] = [];

  for (const c of changes) {
    if (typeProductIds && !typeProductIds.has(c.productId)) continue;

    const changeUsd = c.newPrice - c.oldPrice;
    const changePct = (changeUsd / c.oldPrice) * 100;

    if (Math.abs(changeUsd) < minUsd || Math.abs(changePct) < minPct) continue;

    const product = await productRepo.findById(c.productId);
    if (!product) continue;

    const mover: PriceMover = {
      productId: c.productId,
      title: product.title,
      platform: product.platform ?? "",
      condition,
      previousPrice: c.oldPrice,
      currentPrice: c.newPrice,
      changeUsd,
      changePct,
      previousDate,
      currentDate,
    };

    if (changePct > 0) risers.push(mover);
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
export async function platformTrends(
  condition = "loose",
): Promise<Array<{ platform: string; avgChangePct: number; productCount: number }>> {
  const changes = await pricePointRepo.findPriceChanges({
    condition,
    minPriceUsd: 10,
    limit: 100_000,
  });

  if (changes.length === 0) return [];

  // Group by platform
  const platformMap = new Map<string, { totalPct: number; count: number }>();

  for (const c of changes) {
    const product = await productRepo.findById(c.productId);
    if (!product?.platform) continue;

    const changePct = ((c.newPrice - c.oldPrice) / c.oldPrice) * 100;
    const entry = platformMap.get(product.platform) ?? { totalPct: 0, count: 0 };
    entry.totalPct += changePct;
    entry.count += 1;
    platformMap.set(product.platform, entry);
  }

  const results: Array<{ platform: string; avgChangePct: number; productCount: number }> = [];
  for (const [platform, data] of platformMap) {
    if (data.count < 10) continue;
    results.push({
      platform,
      avgChangePct: data.totalPct / data.count,
      productCount: data.count,
    });
  }

  results.sort((a, b) => b.avgChangePct - a.avgChangePct);
  return results;
}
