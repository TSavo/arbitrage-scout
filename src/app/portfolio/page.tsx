export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import { opportunities, products, pricePoints } from "@/db/schema";
import { eq, desc, sql } from "drizzle-orm";
import { PortfolioClient, type PortfolioDeal, type CategoryBreakdown, type PortfolioSummary } from "./PortfolioClient";

export default async function PortfolioPage() {
  // Get all purchased opportunities with product info
  const rows = await db
    .select({
      id: opportunities.id,
      productId: opportunities.productId,
      listingPriceUsd: opportunities.listingPriceUsd,
      marketPriceUsd: opportunities.marketPriceUsd,
      profitUsd: opportunities.profitUsd,
      marginPct: opportunities.marginPct,
      feesUsd: opportunities.feesUsd,
      foundAt: opportunities.foundAt,
      buyPriceUsd: opportunities.buyPriceUsd,
      salePriceUsd: opportunities.salePriceUsd,
      saleDate: opportunities.saleDate,
      actualFeesUsd: opportunities.actualFeesUsd,
      productTitle: products.title,
      productPlatform: products.platform,
      productTypeId: products.productTypeId,
    })
    .from(opportunities)
    .leftJoin(products, eq(opportunities.productId, products.id))
    .where(eq(opportunities.status, "purchased"))
    .orderBy(desc(opportunities.foundAt));

  // Get latest price point per product+condition for current market prices
  const productIds = [...new Set(rows.map((r) => r.productId))];
  const latestPrices = new Map<string, number>();

  if (productIds.length > 0) {
    // Get the latest price point for each product
    const prices = await db
      .select({
        productId: pricePoints.productId,
        priceUsd: pricePoints.priceUsd,
        recordedAt: pricePoints.recordedAt,
      })
      .from(pricePoints)
      .orderBy(desc(pricePoints.recordedAt));

    // Keep only the latest price per product
    for (const pp of prices) {
      if (!latestPrices.has(pp.productId)) {
        latestPrices.set(pp.productId, pp.priceUsd);
      }
    }
  }

  // Build deals array
  const deals: PortfolioDeal[] = rows.map((r) => {
    const buyPrice = r.buyPriceUsd ?? r.listingPriceUsd;
    const currentMarketPrice = latestPrices.get(r.productId) ?? r.marketPriceUsd;
    const fees = r.actualFeesUsd ?? r.feesUsd;
    const isSold = r.salePriceUsd != null;
    const actualProfit = isSold
      ? r.salePriceUsd! - fees - buyPrice
      : null;
    const unrealizedProfit = !isSold
      ? currentMarketPrice - buyPrice
      : null;

    return {
      id: r.id,
      productId: r.productId,
      productTitle: r.productTitle ?? "Unknown",
      productPlatform: r.productPlatform ?? "",
      productTypeId: r.productTypeId ?? "unknown",
      buyPrice,
      currentMarketPrice,
      predictedProfit: r.profitUsd,
      actualProfit,
      unrealizedProfit,
      salePriceUsd: r.salePriceUsd,
      saleDate: r.saleDate,
      actualFeesUsd: r.actualFeesUsd,
      feesUsd: r.feesUsd,
      foundAt: r.foundAt,
      isSold,
    };
  });

  // Compute summary stats
  const totalInvested = deals.reduce((s, d) => s + d.buyPrice, 0);
  const soldDeals = deals.filter((d) => d.isSold);
  const holdingDeals = deals.filter((d) => !d.isSold);
  const realizedPnl = soldDeals.reduce((s, d) => s + (d.actualProfit ?? 0), 0);
  const unrealizedPnl = holdingDeals.reduce((s, d) => s + (d.unrealizedProfit ?? 0), 0);
  const totalReturn = totalInvested > 0 ? ((realizedPnl + unrealizedPnl) / totalInvested) * 100 : 0;

  const summary: PortfolioSummary = {
    totalInvested,
    realizedPnl,
    unrealizedPnl,
    totalReturn,
    totalItems: deals.length,
    soldItems: soldDeals.length,
  };

  // Category breakdown
  const categoryMap = new Map<string, { realized: number; unrealized: number }>();
  for (const d of deals) {
    const cat = d.productTypeId;
    const existing = categoryMap.get(cat) ?? { realized: 0, unrealized: 0 };
    if (d.isSold) {
      existing.realized += d.actualProfit ?? 0;
    } else {
      existing.unrealized += d.unrealizedProfit ?? 0;
    }
    categoryMap.set(cat, existing);
  }

  const categoryBreakdown: CategoryBreakdown[] = Array.from(categoryMap.entries()).map(
    ([category, { realized, unrealized }]) => ({
      category: category.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      realized: Math.round(realized * 100) / 100,
      unrealized: Math.round(unrealized * 100) / 100,
    })
  );

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Portfolio</h2>
        <p className="text-muted-foreground text-sm mt-0.5">
          Track your purchases, sales, and P&L
        </p>
      </div>
      <PortfolioClient
        summary={summary}
        categoryBreakdown={categoryBreakdown}
        deals={deals}
      />
    </div>
  );
}
