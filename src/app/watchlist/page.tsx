export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import { watchlistItems, products, pricePoints } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { WatchlistClient } from "./WatchlistClient";

export default async function WatchlistPage() {
  // Fetch watchlist items joined with products
  const items = db
    .select({
      id: watchlistItems.id,
      productId: watchlistItems.productId,
      targetPricePct: watchlistItems.targetPricePct,
      condition: watchlistItems.condition,
      createdAt: watchlistItems.createdAt,
      triggeredAt: watchlistItems.triggeredAt,
      active: watchlistItems.active,
      notes: watchlistItems.notes,
      productTitle: products.title,
      platform: products.platform,
    })
    .from(watchlistItems)
    .innerJoin(products, eq(watchlistItems.productId, products.id))
    .orderBy(desc(watchlistItems.createdAt))
    .all();

  // Get latest price per product+condition
  const priceRows = db
    .select({
      productId: pricePoints.productId,
      condition: pricePoints.condition,
      priceUsd: pricePoints.priceUsd,
      recordedAt: pricePoints.recordedAt,
    })
    .from(pricePoints)
    .orderBy(desc(pricePoints.recordedAt))
    .all();

  const priceMap = new Map<string, number>();
  for (const p of priceRows) {
    const key = `${p.productId}|${p.condition}`;
    if (!priceMap.has(key)) priceMap.set(key, p.priceUsd);
  }

  // Enrich watchlist items with computed values
  const watchlistData = items.map((item) => {
    const key = `${item.productId}|${item.condition}`;
    const marketPrice = priceMap.get(key) ?? null;
    const targetPrice =
      marketPrice != null
        ? marketPrice * (1 - item.targetPricePct / 100)
        : null;
    const triggered =
      marketPrice != null && targetPrice != null && marketPrice <= targetPrice;
    const gapPct =
      marketPrice != null && targetPrice != null && marketPrice > 0
        ? ((marketPrice - targetPrice) / marketPrice) * 100
        : null;

    return {
      ...item,
      marketPrice,
      targetPrice,
      triggered,
      gapPct,
    };
  });

  // Summary stats
  const totalWatching = watchlistData.filter((w) => w.active).length;
  const triggeredAlerts = watchlistData.filter(
    (w) => w.active && w.triggered,
  ).length;
  const activeWithTarget = watchlistData.filter(
    (w) => w.active && w.targetPricePct != null,
  );
  const avgTargetDiscount =
    activeWithTarget.length > 0
      ? activeWithTarget.reduce((sum, w) => sum + w.targetPricePct, 0) /
        activeWithTarget.length
      : 0;

  // Top 500 products by sales volume for the add-to-watchlist picker
  const productList = db
    .select({
      id: products.id,
      title: products.title,
      platform: products.platform,
    })
    .from(products)
    .orderBy(desc(products.salesVolume))
    .limit(500)
    .all();

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Watchlist</h2>
        <p className="text-muted-foreground text-sm mt-0.5">
          Track products and get alerts when prices drop
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Total Watching
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{totalWatching}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Triggered Alerts
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold text-green-400">
              {triggeredAlerts}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Avg Target Discount
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{avgTargetDiscount.toFixed(1)}%</p>
          </CardContent>
        </Card>
      </div>

      <WatchlistClient items={watchlistData} products={productList} />
    </div>
  );
}
