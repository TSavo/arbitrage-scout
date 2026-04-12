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
  /** Dominant taxonomy node id (most common node for products on this platform). */
  taxonomyNodeId: number | null;
  /** Canonical path of the category ancestor (depth ≤ 3, e.g.
   *  "/collectibles/trading_cards/pokemon"). Rolled up from the leaf node so
   *  one platform → one category, matching what product_type_id used to do. */
  taxonomyPath: string;
  /** Label of the category ancestor (from taxonomy_nodes.label). */
  taxonomyLabel: string;
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

/** Depth of a path_cache (slash count), treating root "/root" as depth 1. */
function depthOf(pathCache: string): number {
  return (pathCache.match(/\//g) ?? []).length;
}

/** Collapse a leaf taxonomy node to its category ancestor (depth ≤ 3). */
function buildCategoryAncestorMap(): Map<number, { id: number; path: string; label: string }> {
  const nodes = db.all<{ id: number; parent_id: number | null; path_cache: string; label: string }>(
    sql`SELECT id, parent_id, path_cache, label FROM taxonomy_nodes`,
  );
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const ancestor = new Map<number, { id: number; path: string; label: string }>();

  for (const leaf of nodes) {
    let cur: typeof leaf | undefined = leaf;
    while (cur && depthOf(cur.path_cache) > 3) {
      cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
    }
    if (cur) {
      ancestor.set(leaf.id, { id: cur.id, path: cur.path_cache, label: cur.label });
    }
  }
  return ancestor;
}

/**
 * Profile every platform in the catalog, optionally restricted to a taxonomy subtree.
 */
export function profilePlatforms(
  opts: { taxonomyPathPrefix?: string; minProducts?: number } = {},
): PlatformProfile[] {
  const minProducts = opts.minProducts ?? 20;

  section("PLATFORM ANALYSIS");

  const ancestorMap = buildCategoryAncestorMap();

  const subtreeFilter = opts.taxonomyPathPrefix
    ? sql`AND t.path_cache LIKE ${opts.taxonomyPathPrefix + "%"}`
    : sql``;

  // One aggregate per (platform, taxonomy_node_id). Rolled up in JS below.
  const raw = db.all<{
    platform: string;
    taxonomy_node_id: number;
    product_count: number;
    avg_loose: number | null;
    avg_cib: number | null;
    avg_new: number | null;
    total_volume: number;
    avg_volume: number;
    pct_50: number | null;
    pct_100: number | null;
    loose_count: number;
  }>(sql`
    SELECT
      p.platform,
      p.taxonomy_node_id,
      COUNT(DISTINCT p.id) as product_count,
      ROUND(AVG(pp_loose.price_usd), 2) as avg_loose,
      ROUND(AVG(pp_cib.price_usd), 2) as avg_cib,
      ROUND(AVG(pp_new.price_usd), 2) as avg_new,
      SUM(p.sales_volume) as total_volume,
      ROUND(AVG(p.sales_volume), 1) as avg_volume,
      ROUND(SUM(CASE WHEN pp_loose.price_usd >= 50 THEN 1 ELSE 0 END) * 100.0
            / NULLIF(COUNT(pp_loose.price_usd), 0), 1) as pct_50,
      ROUND(SUM(CASE WHEN pp_loose.price_usd >= 100 THEN 1 ELSE 0 END) * 100.0
            / NULLIF(COUNT(pp_loose.price_usd), 0), 1) as pct_100,
      COUNT(pp_loose.price_usd) as loose_count
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
    GROUP BY p.platform, p.taxonomy_node_id
  `);

  // Roll up by (platform, category_ancestor). One platform's products may
  // scatter across multiple leaves; we pick the ancestor with the most
  // products to represent the platform, matching the old product_type_id
  // granularity.
  interface Bucket {
    platform: string;
    catPath: string;
    catLabel: string;
    catNodeId: number;
    productCount: number;
    looseSum: number;
    looseCount: number;
    cibSum: number;
    cibCount: number;
    newSum: number;
    newCount: number;
    totalVolume: number;
    volumeWeightedSum: number;
    pctAbove50Weighted: number;
    pctAbove100Weighted: number;
  }
  const byPlatform = new Map<string, Map<string, Bucket>>();

  for (const r of raw) {
    const cat = ancestorMap.get(r.taxonomy_node_id);
    if (!cat) continue;
    let cats = byPlatform.get(r.platform);
    if (!cats) {
      cats = new Map();
      byPlatform.set(r.platform, cats);
    }
    let b = cats.get(cat.path);
    if (!b) {
      b = {
        platform: r.platform,
        catPath: cat.path,
        catLabel: cat.label,
        catNodeId: cat.id,
        productCount: 0,
        looseSum: 0,
        looseCount: 0,
        cibSum: 0,
        cibCount: 0,
        newSum: 0,
        newCount: 0,
        totalVolume: 0,
        volumeWeightedSum: 0,
        pctAbove50Weighted: 0,
        pctAbove100Weighted: 0,
      };
      cats.set(cat.path, b);
    }
    b.productCount += r.product_count;
    if (r.avg_loose != null) {
      b.looseSum += r.avg_loose * r.product_count;
      b.looseCount += r.product_count;
    }
    if (r.avg_cib != null) {
      b.cibSum += r.avg_cib * r.product_count;
      b.cibCount += r.product_count;
    }
    if (r.avg_new != null) {
      b.newSum += r.avg_new * r.product_count;
      b.newCount += r.product_count;
    }
    b.totalVolume += r.total_volume;
    b.volumeWeightedSum += r.avg_volume * r.product_count;
    if (r.pct_50 != null) b.pctAbove50Weighted += r.pct_50 * r.loose_count;
    if (r.pct_100 != null) b.pctAbove100Weighted += r.pct_100 * r.loose_count;
  }

  // Pick dominant category per platform, assemble final profiles.
  const finalBuckets: Bucket[] = [];
  for (const [, cats] of byPlatform) {
    let winner: Bucket | null = null;
    let winnerCount = -1;
    let totalCount = 0;
    for (const b of cats.values()) {
      totalCount += b.productCount;
      if (b.productCount > winnerCount) {
        winnerCount = b.productCount;
        winner = b;
      }
    }
    if (winner && totalCount >= minProducts) {
      // Merge all cats' product counts into the winner so the "total" is the
      // platform-wide count, while the category label is the dominant one.
      let merged: Bucket = { ...winner, productCount: 0, looseSum: 0, looseCount: 0,
        cibSum: 0, cibCount: 0, newSum: 0, newCount: 0, totalVolume: 0,
        volumeWeightedSum: 0, pctAbove50Weighted: 0, pctAbove100Weighted: 0 };
      for (const b of cats.values()) {
        merged.productCount += b.productCount;
        merged.looseSum += b.looseSum; merged.looseCount += b.looseCount;
        merged.cibSum += b.cibSum; merged.cibCount += b.cibCount;
        merged.newSum += b.newSum; merged.newCount += b.newCount;
        merged.totalVolume += b.totalVolume;
        merged.volumeWeightedSum += b.volumeWeightedSum;
        merged.pctAbove50Weighted += b.pctAbove50Weighted;
        merged.pctAbove100Weighted += b.pctAbove100Weighted;
      }
      finalBuckets.push(merged);
    }
  }
  finalBuckets.sort((a, b) => {
    const al = a.looseCount ? a.looseSum / a.looseCount : Infinity;
    const bl = b.looseCount ? b.looseSum / b.looseCount : Infinity;
    return al - bl;
  });

  // Batch median + top5 via window functions — single query for all platforms.
  const medianByPlatform = new Map<string, number>();
  {
    const rows = db.all<{ platform: string; price_usd: number }>(sql`
      WITH ranked AS (
        SELECT
          p.platform,
          pp.price_usd,
          ROW_NUMBER() OVER (PARTITION BY p.platform ORDER BY pp.price_usd) as rn,
          COUNT(*) OVER (PARTITION BY p.platform) as n
        FROM price_points pp
        JOIN products p ON p.id = pp.product_id
        WHERE pp.condition = 'loose' AND pp.price_usd > 0
      )
      SELECT platform, price_usd FROM ranked WHERE rn = (n + 1) / 2
    `);
    for (const r of rows) medianByPlatform.set(r.platform, r.price_usd);
  }

  const top5ByPlatform = new Map<string, Array<{ title: string; loosePrice: number; volume: number }>>();
  {
    const rows = db.all<{ platform: string; title: string; loose_price: number; volume: number; rn: number }>(sql`
      WITH ranked AS (
        SELECT
          p.platform,
          p.title,
          pp.price_usd as loose_price,
          p.sales_volume as volume,
          ROW_NUMBER() OVER (PARTITION BY p.platform ORDER BY p.sales_volume DESC) as rn
        FROM products p
        JOIN price_points pp ON pp.product_id = p.id
        WHERE pp.condition = 'loose' AND pp.price_usd > 0
      )
      SELECT platform, title, loose_price, volume, rn FROM ranked WHERE rn <= 5
    `);
    for (const r of rows) {
      let arr = top5ByPlatform.get(r.platform);
      if (!arr) { arr = []; top5ByPlatform.set(r.platform, arr); }
      arr.push({ title: r.title, loosePrice: r.loose_price, volume: r.volume });
    }
  }

  const profiles: PlatformProfile[] = finalBuckets.map((b) => {
    const avgLoose = b.looseCount ? b.looseSum / b.looseCount : 0;
    const avgCib = b.cibCount ? b.cibSum / b.cibCount : 0;
    const avgNew = b.newCount ? b.newSum / b.newCount : 0;
    const avgVolume = b.productCount ? b.volumeWeightedSum / b.productCount : 0;
    const pctAbove50 = b.looseCount ? b.pctAbove50Weighted / b.looseCount : 0;
    const pctAbove100 = b.looseCount ? b.pctAbove100Weighted / b.looseCount : 0;
    return {
      platform: b.platform,
      taxonomyNodeId: b.catNodeId,
      taxonomyPath: b.catPath,
      taxonomyLabel: b.catLabel,
      productCount: b.productCount,
      avgLoose: Math.round(avgLoose * 100) / 100,
      medianLoose: medianByPlatform.get(b.platform) ?? 0,
      avgCib: Math.round(avgCib * 100) / 100,
      avgNew: Math.round(avgNew * 100) / 100,
      cibToLooseRatio: avgCib && avgLoose ? avgCib / avgLoose : 0,
      totalVolume: b.totalVolume,
      avgVolume: Math.round(avgVolume * 10) / 10,
      pctAbove50: Math.round(pctAbove50 * 10) / 10,
      pctAbove100: Math.round(pctAbove100 * 10) / 10,
      top5Products: top5ByPlatform.get(b.platform) ?? [],
    };
  });

  log("platforms", `profiled ${profiles.length} platforms`);
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
