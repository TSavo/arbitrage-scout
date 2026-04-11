/**
 * Undervalued platform analysis.
 *
 * Identifies consoles/sets where prices are likely to rise based on:
 * - Low average price relative to comparable platforms
 * - High sales volume (active market, not dead)
 * - Cultural relevance signals (nostalgia cycle, retro gaming trends)
 * - Supply constraints (fewer copies = scarcer = eventual price increase)
 */

import { and, eq, gte, sql, desc, asc } from "drizzle-orm";
import { db } from "@/db/client";
import { products, pricePoints } from "@/db/schema";
import { log, section } from "@/lib/logger";

export interface PlatformProfile {
  platform: string;
  productType: string;
  productCount: number;
  avgLoose: number;
  medianLoose: number;
  avgCib: number;
  avgNew: number;
  cibToLooseRatio: number;
  totalVolume: number;
  avgVolume: number;
  pctAbove50: number; // % of products worth >$50
  pctAbove100: number;
  top5Products: Array<{ title: string; loosePrice: number; volume: number }>;
}

/**
 * Profile every platform in the catalog.
 */
export function profilePlatforms(
  opts: { productType?: string; minProducts?: number } = {},
): PlatformProfile[] {
  const minProducts = opts.minProducts ?? 20;

  section("PLATFORM ANALYSIS");

  // Alias tables for the three condition joins
  const ppLoose = db.$with("pp_loose").as(
    db
      .select({
        productId: pricePoints.productId,
        priceUsd: pricePoints.priceUsd,
      })
      .from(pricePoints)
      .where(and(eq(pricePoints.condition, "loose"), gte(pricePoints.priceUsd, 0.01))),
  );

  // Build conditions for main query
  const conditions = [sql`pp_loose.price_usd IS NOT NULL`];
  if (opts.productType) {
    conditions.push(eq(products.productTypeId, opts.productType));
  }

  // Get platform stats using Drizzle sql template for complex aggregates
  const platforms = db.all<{
    platform: string;
    product_type_id: string;
    product_count: number;
    avg_loose: number;
    avg_cib: number | null;
    avg_new: number | null;
    total_volume: number;
    avg_volume: number;
  }>(sql`
    SELECT
      p.platform,
      p.product_type_id,
      COUNT(DISTINCT p.id) as product_count,
      ROUND(AVG(pp_loose.price_usd), 2) as avg_loose,
      ROUND(AVG(pp_cib.price_usd), 2) as avg_cib,
      ROUND(AVG(pp_new.price_usd), 2) as avg_new,
      SUM(p.sales_volume) as total_volume,
      ROUND(AVG(p.sales_volume), 1) as avg_volume
    FROM products p
    LEFT JOIN price_points pp_loose ON pp_loose.product_id = p.id
      AND pp_loose.condition = 'loose' AND pp_loose.price_usd > 0
    LEFT JOIN price_points pp_cib ON pp_cib.product_id = p.id
      AND pp_cib.condition = 'cib' AND pp_cib.price_usd > 0
    LEFT JOIN price_points pp_new ON pp_new.product_id = p.id
      AND pp_new.condition = 'new_sealed' AND pp_new.price_usd > 0
    WHERE pp_loose.price_usd IS NOT NULL
      ${opts.productType ? sql`AND p.product_type_id = ${opts.productType}` : sql``}
    GROUP BY p.platform, p.product_type_id
    HAVING product_count >= ${minProducts}
    ORDER BY avg_loose ASC
  `);

  const profiles: PlatformProfile[] = [];

  for (const plat of platforms) {
    log("platforms", `profiling ${plat.platform} (${plat.product_count} products)...`);

    // Median loose price
    const medianRow = db.get<{ price_usd: number }>(sql`
      SELECT pp.price_usd FROM price_points pp
      JOIN products p ON p.id = pp.product_id
      WHERE p.platform = ${plat.platform} AND pp.condition = 'loose' AND pp.price_usd > 0
      ORDER BY pp.price_usd
      LIMIT 1 OFFSET (
        SELECT COUNT(*)/2 FROM price_points pp2
        JOIN products p2 ON p2.id = pp2.product_id
        WHERE p2.platform = ${plat.platform} AND pp2.condition = 'loose' AND pp2.price_usd > 0
      )
    `);

    // % above $50 and $100
    const thresholds = db.get<{ pct_50: number; pct_100: number }>(sql`
      SELECT
        SUM(CASE WHEN pp.price_usd >= 50 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as pct_50,
        SUM(CASE WHEN pp.price_usd >= 100 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as pct_100
      FROM price_points pp
      JOIN products p ON p.id = pp.product_id
      WHERE p.platform = ${plat.platform} AND pp.condition = 'loose' AND pp.price_usd > 0
    `);

    // Top 5 by volume
    const top5 = db.all<{ title: string; loose_price: number; volume: number }>(sql`
      SELECT p.title, pp.price_usd as loose_price, p.sales_volume as volume
      FROM products p
      JOIN price_points pp ON pp.product_id = p.id
      WHERE p.platform = ${plat.platform} AND pp.condition = 'loose' AND pp.price_usd > 0
      ORDER BY p.sales_volume DESC
      LIMIT 5
    `);

    profiles.push({
      platform: plat.platform,
      productType: plat.product_type_id,
      productCount: plat.product_count,
      avgLoose: plat.avg_loose,
      medianLoose: medianRow?.price_usd ?? 0,
      avgCib: plat.avg_cib ?? 0,
      avgNew: plat.avg_new ?? 0,
      cibToLooseRatio: plat.avg_cib && plat.avg_loose ? plat.avg_cib / plat.avg_loose : 0,
      totalVolume: plat.total_volume,
      avgVolume: plat.avg_volume,
      pctAbove50: thresholds?.pct_50 ?? 0,
      pctAbove100: thresholds?.pct_100 ?? 0,
      top5Products: top5.map((t) => ({
        title: t.title,
        loosePrice: t.loose_price,
        volume: t.volume,
      })),
    });
  }

  return profiles;
}

/**
 * Find undervalued platforms — low prices but high activity.
 * These are the ones most likely to appreciate.
 */
export function findUndervaluedPlatforms(
  opts: { productType?: string } = {},
): PlatformProfile[] {
  const profiles = profilePlatforms({ ...opts, minProducts: 30 });

  // Score each platform: high volume + low median price = undervalued
  // Normalize both to 0-1 range, then combine
  const maxVolume = Math.max(...profiles.map((p) => p.avgVolume));
  const maxMedian = Math.max(...profiles.map((p) => p.medianLoose));

  const scored = profiles
    .filter((p) => p.productType === "retro_game") // focus on games for now
    .map((p) => {
      const volumeScore = p.avgVolume / maxVolume; // higher = more active
      const priceScore = 1 - p.medianLoose / maxMedian; // lower price = higher score
      const ratioScore = Math.min(p.cibToLooseRatio / 5, 1); // high CIB/loose ratio = box matters = collectible
      const combined = volumeScore * 0.4 + priceScore * 0.3 + ratioScore * 0.3;
      return { ...p, undervalueScore: combined };
    })
    .sort((a, b) => b.undervalueScore - a.undervalueScore);

  section("UNDERVALUED PLATFORMS");
  log("platforms", "scored by: 40% volume + 30% low price + 30% CIB/loose ratio");
  for (const p of scored.slice(0, 15)) {
    const s = (p as any).undervalueScore as number;
    log(
      "platforms",
      `  score=${s.toFixed(2)}  ${p.platform.padEnd(25)} median=$${p.medianLoose.toFixed(2).padStart(8)} ` +
        `avg=$${p.avgLoose.toFixed(2).padStart(8)}  CIB/loose=${p.cibToLooseRatio.toFixed(1)}x  ` +
        `vol=${p.avgVolume.toFixed(0).padStart(5)}  ${p.productCount} products`,
    );
  }

  return scored;
}
