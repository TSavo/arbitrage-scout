export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import { sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { taxonomyRepo } from "@/db/repos/TaxonomyRepo";
import CategoryClient from "./CategoryClient";

type MoverRow = {
  product_id: string;
  first_price: number;
  last_price: number;
  change_pct: number;
  title: string;
  platform: string | null;
};

type SparklineRow = {
  product_id: string;
  price_usd: number;
};

type DealRow = {
  product_id: string;
  title: string;
  platform: string | null;
  marketplace_name: string;
  listing_price_usd: number;
  market_price_usd: number;
  profit_usd: number;
  margin_pct: number;
  url: string | null;
};

type BucketRow = {
  bucket: string;
  count: number;
};

type PlatformRow = {
  platform: string;
  product_count: number;
  avg_price: number;
  avg_volume: number;
};

type StatsRow = {
  product_count: number;
  avg_loose: number | null;
  avg_volume: number;
  total_opportunities: number;
  avg_margin: number | null;
};

// Route param `[typeId]` now carries the integer taxonomy node id.
export default async function CategoryPage(
  props: PageProps<"/categories/[typeId]">
) {
  const { typeId } = await props.params;
  const nodeId = Number(typeId);
  if (!Number.isFinite(nodeId) || !Number.isInteger(nodeId)) notFound();

  const node = await taxonomyRepo.getNode(nodeId);
  if (!node) notFound();

  // Ancestor chain for breadcrumb (root → ... → node).
  const breadcrumb = (await taxonomyRepo.getPath(node.id)).map((n) => ({
    id: n.id,
    label: n.label,
    slug: n.slug,
  }));

  // Subtree match: product's taxonomy_node_id must resolve to a taxonomy_node
  // whose path_cache starts with this node's path_cache (self + descendants).
  const pathPrefix = node.pathCache;
  const subtreeLike = `${pathPrefix}/%`;

  // Stats
  let stats: StatsRow = {
    product_count: 0,
    avg_loose: null,
    avg_volume: 0,
    total_opportunities: 0,
    avg_margin: null,
  };

  try {
    const rows = (await db.execute(sql`
      SELECT
        COUNT(DISTINCT p.id) as product_count,
        ROUND(AVG(CASE WHEN pp.condition = 'loose' AND pp.recorded_at = (
          SELECT MAX(pp2.recorded_at) FROM price_points pp2
          WHERE pp2.product_id = p.id AND pp2.condition = 'loose'
        ) THEN pp.price_usd END), 2) as avg_loose,
        ROUND(AVG(p.sales_volume), 0) as avg_volume,
        COUNT(DISTINCT CASE WHEN o.status = 'new' THEN o.id END) as total_opportunities,
        ROUND(AVG(CASE WHEN o.status = 'new' THEN o.margin_pct END), 3) as avg_margin
      FROM products p
      JOIN taxonomy_nodes tn ON tn.id = p.taxonomy_node_id
      LEFT JOIN price_points pp ON pp.product_id = p.id
      LEFT JOIN opportunities o ON o.product_id = p.id
      WHERE (tn.path_cache = ${pathPrefix} OR tn.path_cache LIKE ${subtreeLike})
    `)) as unknown as StatsRow[];
    if (rows[0]) stats = rows[0];
  } catch {
    // ok
  }

  // Top movers (last 30 days)
  let movers: (MoverRow & { change_usd: number })[] = [];
  try {
    movers = (await db.execute(sql`
      WITH first_last AS (
        SELECT pp.product_id,
          FIRST_VALUE(pp.price_usd) OVER (PARTITION BY pp.product_id ORDER BY pp.recorded_at ASC) as first_price,
          FIRST_VALUE(pp.price_usd) OVER (PARTITION BY pp.product_id ORDER BY pp.recorded_at DESC) as last_price
        FROM price_points pp
        JOIN products p ON p.id = pp.product_id
        JOIN taxonomy_nodes tn ON tn.id = p.taxonomy_node_id
        WHERE (tn.path_cache = ${pathPrefix} OR tn.path_cache LIKE ${subtreeLike})
          AND pp.condition = 'loose'
          AND pp.price_usd > 0
          AND pp.recorded_at::date >= CURRENT_DATE - INTERVAL '30 days'
      )
      SELECT DISTINCT fl.product_id, fl.first_price, fl.last_price,
        ROUND((fl.last_price - fl.first_price) / fl.first_price * 100, 1) as change_pct,
        ROUND(fl.last_price - fl.first_price, 2) as change_usd,
        p.title, p.platform
      FROM first_last fl
      JOIN products p ON p.id = fl.product_id
      WHERE fl.first_price >= 5
      ORDER BY ABS(change_pct) DESC
      LIMIT 10
    `)) as unknown as (MoverRow & { change_usd: number })[];
  } catch {
    // ok
  }

  // Sparkline data for movers
  const sparklineMap: Record<string, { value: number }[]> = {};
  if (movers.length > 0) {
    try {
      const ids = movers.map((m) => m.product_id);
      const idList = sql.join(ids.map((id) => sql`${id}`), sql`, `);
      const sparkRows = (await db.execute(sql`
        SELECT product_id, price_usd
        FROM price_points
        WHERE product_id IN (${idList})
          AND condition = 'loose'
          AND price_usd > 0
          AND recorded_at::date >= CURRENT_DATE - INTERVAL '30 days'
        ORDER BY product_id, recorded_at ASC
      `)) as unknown as SparklineRow[];

      for (const row of sparkRows) {
        if (!sparklineMap[row.product_id]) {
          sparklineMap[row.product_id] = [];
        }
        sparklineMap[row.product_id].push({ value: row.price_usd });
      }
    } catch {
      // optional
    }
  }

  // Best current deals
  let deals: DealRow[] = [];
  try {
    deals = (await db.execute(sql`
      SELECT
        o.product_id,
        p.title,
        p.platform,
        m.name as marketplace_name,
        o.listing_price_usd,
        o.market_price_usd,
        o.profit_usd,
        o.margin_pct,
        l.url
      FROM opportunities o
      JOIN products p ON p.id = o.product_id
      JOIN taxonomy_nodes tn ON tn.id = p.taxonomy_node_id
      JOIN listings l ON l.id = o.listing_id
      JOIN marketplaces m ON m.id = l.marketplace_id
      WHERE o.status = 'new'
        AND (tn.path_cache = ${pathPrefix} OR tn.path_cache LIKE ${subtreeLike})
      ORDER BY o.margin_pct DESC
      LIMIT 15
    `)) as unknown as DealRow[];
  } catch {
    // ok
  }

  // Price distribution
  let distribution: BucketRow[] = [];
  try {
    distribution = (await db.execute(sql`
      SELECT
        CASE
          WHEN pp.price_usd < 10 THEN '$0-10'
          WHEN pp.price_usd < 25 THEN '$10-25'
          WHEN pp.price_usd < 50 THEN '$25-50'
          WHEN pp.price_usd < 100 THEN '$50-100'
          WHEN pp.price_usd < 250 THEN '$100-250'
          WHEN pp.price_usd < 500 THEN '$250-500'
          ELSE '$500+'
        END as bucket,
        COUNT(DISTINCT pp.product_id) as count
      FROM price_points pp
      JOIN products p ON p.id = pp.product_id
      JOIN taxonomy_nodes tn ON tn.id = p.taxonomy_node_id
      WHERE (tn.path_cache = ${pathPrefix} OR tn.path_cache LIKE ${subtreeLike})
        AND pp.condition = 'loose'
        AND pp.recorded_at = (SELECT MAX(recorded_at) FROM price_points WHERE product_id = pp.product_id AND condition = 'loose')
      GROUP BY bucket
    `)) as unknown as BucketRow[];
  } catch {
    // ok
  }

  // Sort distribution buckets in a sensible order
  const bucketOrder = [
    "$0-10",
    "$10-25",
    "$25-50",
    "$50-100",
    "$100-250",
    "$250-500",
    "$500+",
  ];
  distribution.sort(
    (a, b) => bucketOrder.indexOf(a.bucket) - bucketOrder.indexOf(b.bucket),
  );

  // Top platforms/sets
  let platforms: PlatformRow[] = [];
  try {
    platforms = (await db.execute(sql`
      SELECT
        p.platform,
        COUNT(DISTINCT p.id) as product_count,
        ROUND(AVG(CASE WHEN pp.condition = 'loose' AND pp.recorded_at = (
          SELECT MAX(pp2.recorded_at) FROM price_points pp2
          WHERE pp2.product_id = p.id AND pp2.condition = 'loose'
        ) THEN pp.price_usd END), 2) as avg_price,
        ROUND(AVG(p.sales_volume), 0) as avg_volume
      FROM products p
      JOIN taxonomy_nodes tn ON tn.id = p.taxonomy_node_id
      LEFT JOIN price_points pp ON pp.product_id = p.id
      WHERE (tn.path_cache = ${pathPrefix} OR tn.path_cache LIKE ${subtreeLike})
        AND p.platform IS NOT NULL
      GROUP BY p.platform
      HAVING COUNT(DISTINCT p.id) >= 5
      ORDER BY COUNT(DISTINCT p.id) DESC
      LIMIT 30
    `)) as unknown as PlatformRow[];
  } catch {
    // ok
  }

  // Heuristic: video-game-like nodes want "Top Platforms" label, others use
  // "Top Sets / Platforms". Replaces the old hardcoded `retro_game` check.
  const isVideoGameBranch = node.pathCache.startsWith("/electronics/video_games");

  return (
    <CategoryClient
      node={{
        id: node.id,
        label: node.label,
        slug: node.slug,
        pathCache: node.pathCache,
        description: node.description ?? null,
      }}
      breadcrumb={breadcrumb}
      isVideoGameBranch={isVideoGameBranch}
      stats={stats}
      movers={movers}
      sparklineMap={sparklineMap}
      deals={deals}
      distribution={distribution}
      platforms={platforms}
    />
  );
}
