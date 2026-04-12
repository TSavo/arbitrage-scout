/**
 * Undervalued platform analysis.
 *
 * Identifies consoles/sets where prices are likely to rise based on:
 * - Low average price relative to comparable platforms
 * - High sales volume (active market, not dead)
 * - Cultural relevance signals (nostalgia cycle, retro gaming trends)
 * - Supply constraints (fewer copies = scarcer = eventual price increase)
 */

import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { log, section } from "@/lib/logger";

export interface PlatformProfile {
  platform: string;
  /** Taxonomy node id the platform's products live under. */
  taxonomyNodeId: number | null;
  /** Canonical path of that node (e.g. /electronics/video_games/physical_game_media). */
  taxonomyPath: string;
  productCount: number;
  avgLoose: number;
  medianLoose: number;
  avgCib: number;
  avgNew: number;
  cibToLooseRatio: number;
  totalVolume: number;
  avgVolume: number;
  pctAbove50: number;
  pctAbove100: number;
  top5Products: Array<{ title: string; loosePrice: number; volume: number }>;
}

/**
 * Profile every platform in the catalog, optionally restricted to a taxonomy subtree.
 */
export function profilePlatforms(
  opts: { taxonomyPathPrefix?: string; minProducts?: number } = {},
): PlatformProfile[] {
  const minProducts = opts.minProducts ?? 20;

  section("PLATFORM ANALYSIS");

  const subtreeFilter = opts.taxonomyPathPrefix
    ? sql`AND t.path_cache LIKE ${opts.taxonomyPathPrefix + "%"}`
    : sql``;

  const platforms = db.all<{
    platform: string;
    taxonomy_node_id: number;
    taxonomy_path: string;
    product_count: number;
    avg_loose: number;
    avg_cib: number | null;
    avg_new: number | null;
    total_volume: number;
    avg_volume: number;
  }>(sql`
    SELECT
      p.platform,
      p.taxonomy_node_id,
      t.path_cache as taxonomy_path,
      COUNT(DISTINCT p.id) as product_count,
      ROUND(AVG(pp_loose.price_usd), 2) as avg_loose,
      ROUND(AVG(pp_cib.price_usd), 2) as avg_cib,
      ROUND(AVG(pp_new.price_usd), 2) as avg_new,
      SUM(p.sales_volume) as total_volume,
      ROUND(AVG(p.sales_volume), 1) as avg_volume
    FROM products p
    JOIN taxonomy_nodes t ON t.id = p.taxonomy_node_id
    LEFT JOIN price_points pp_loose ON pp_loose.product_id = p.id
      AND pp_loose.condition = 'loose' AND pp_loose.price_usd > 0
    LEFT JOIN price_points pp_cib ON pp_cib.product_id = p.id
      AND pp_cib.condition = 'cib' AND pp_cib.price_usd > 0
    LEFT JOIN price_points pp_new ON pp_new.product_id = p.id
      AND pp_new.condition = 'new_sealed' AND pp_new.price_usd > 0
    WHERE pp_loose.price_usd IS NOT NULL
      ${subtreeFilter}
    GROUP BY p.platform, p.taxonomy_node_id, t.path_cache
    HAVING product_count >= ${minProducts}
    ORDER BY avg_loose ASC
  `);

  const profiles: PlatformProfile[] = [];

  for (const plat of platforms) {
    log("platforms", `profiling ${plat.platform} (${plat.product_count} products)...`);

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

    const thresholds = db.get<{ pct_50: number; pct_100: number }>(sql`
      SELECT
        SUM(CASE WHEN pp.price_usd >= 50 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as pct_50,
        SUM(CASE WHEN pp.price_usd >= 100 THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as pct_100
      FROM price_points pp
      JOIN products p ON p.id = pp.product_id
      WHERE p.platform = ${plat.platform} AND pp.condition = 'loose' AND pp.price_usd > 0
    `);

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
      taxonomyNodeId: plat.taxonomy_node_id,
      taxonomyPath: plat.taxonomy_path,
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
 * Default scope: retro games (/electronics/video_games/physical_game_media).
 */
export function findUndervaluedPlatforms(
  opts: { taxonomyPathPrefix?: string } = {},
): PlatformProfile[] {
  const prefix = opts.taxonomyPathPrefix ?? "/electronics/video_games/physical_game_media";
  const profiles = profilePlatforms({ taxonomyPathPrefix: prefix, minProducts: 30 });

  const maxVolume = Math.max(...profiles.map((p) => p.avgVolume));
  const maxMedian = Math.max(...profiles.map((p) => p.medianLoose));

  const scored = profiles
    .map((p) => {
      const volumeScore = p.avgVolume / maxVolume;
      const priceScore = 1 - p.medianLoose / maxMedian;
      const ratioScore = Math.min(p.cibToLooseRatio / 5, 1);
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
