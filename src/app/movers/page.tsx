export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import { sql } from "drizzle-orm";
import MoversClient from "./MoversClient";

type MoverRow = {
  product_id: string;
  first_price: number;
  last_price: number;
  change_pct: number;
  change_usd: number;
  title: string;
  platform: string | null;
  taxonomyNodeLabel: string | null;
};

type SparklineRow = {
  product_id: string;
  price_usd: number;
  recorded_at: string;
};

const WINDOWS: Record<string, string> = {
  "7d": "-7 days",
  "30d": "-30 days",
  "90d": "-90 days",
};

export default async function MoversPage(props: {
  searchParams: Promise<{ window?: string }>;
}) {
  const { window: timeWindow = "30d" } = await props.searchParams;
  const interval = WINDOWS[timeWindow] ?? WINDOWS["30d"];
  const validWindow = WINDOWS[timeWindow] ? timeWindow : "30d";

  const moverQueryBase = (orderDir: "DESC" | "ASC") => sql`
    WITH windowed AS (
      SELECT pp.product_id, pp.condition, pp.price_usd, pp.recorded_at,
        ROW_NUMBER() OVER (PARTITION BY pp.product_id, pp.condition ORDER BY pp.recorded_at ASC) as rn_first,
        ROW_NUMBER() OVER (PARTITION BY pp.product_id, pp.condition ORDER BY pp.recorded_at DESC) as rn_last
      FROM price_points pp
      WHERE pp.recorded_at >= date('now', ${interval})
        AND pp.condition = 'loose'
        AND pp.price_usd > 0
    )
    SELECT
      w1.product_id,
      w1.price_usd as first_price,
      w2.price_usd as last_price,
      ROUND((w2.price_usd - w1.price_usd) / w1.price_usd * 100, 1) as change_pct,
      ROUND(w2.price_usd - w1.price_usd, 2) as change_usd,
      p.title,
      p.platform,
      t.label as taxonomyNodeLabel
    FROM windowed w1
    JOIN windowed w2 ON w1.product_id = w2.product_id AND w1.condition = w2.condition
    JOIN products p ON p.id = w1.product_id
    LEFT JOIN taxonomy_nodes t ON t.id = p.taxonomy_node_id
    WHERE w1.rn_first = 1 AND w2.rn_last = 1
      AND w1.price_usd >= 5
      AND ABS(w2.price_usd - w1.price_usd) >= 2
    ORDER BY change_pct ${sql.raw(orderDir)} LIMIT 25
  `;

  let risers: MoverRow[] = [];
  let fallers: MoverRow[] = [];

  try {
    risers = db.all(moverQueryBase("DESC")) as MoverRow[];
    fallers = db.all(moverQueryBase("ASC")) as MoverRow[];
  } catch {
    // Tables might not exist yet
  }

  // Collect all mover product IDs for sparkline data
  const allIds = [
    ...new Set([
      ...risers.map((r) => r.product_id),
      ...fallers.map((f) => f.product_id),
    ]),
  ];

  const sparklineMap: Record<string, { value: number }[]> = {};

  if (allIds.length > 0) {
    try {
      const idList = sql.join(allIds.map((id) => sql`${id}`), sql`, `);
      const sparkRows = db.all(sql`
        SELECT product_id, price_usd, recorded_at
        FROM price_points
        WHERE product_id IN (${idList})
          AND condition = 'loose'
          AND price_usd > 0
          AND recorded_at >= date('now', ${interval})
        ORDER BY product_id, recorded_at ASC
      `) as SparklineRow[];

      for (const row of sparkRows) {
        if (!sparklineMap[row.product_id]) {
          sparklineMap[row.product_id] = [];
        }
        sparklineMap[row.product_id].push({ value: row.price_usd });
      }
    } catch {
      // Sparkline data is optional
    }
  }

  return (
    <MoversClient
      risers={risers}
      fallers={fallers}
      sparklineMap={sparklineMap}
      currentWindow={validWindow}
    />
  );
}
