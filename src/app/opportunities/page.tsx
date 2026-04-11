export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import {
  opportunities,
  listings,
  listingItems,
  marketplaces,
  products,
  pricePoints,
} from "@/db/schema";
import { desc, eq, and } from "drizzle-orm";
import { OpportunitiesTable, type OpportunityRow, type LotItem, type PriceComparison } from "./OpportunitiesTable";

export default async function OpportunitiesPage() {
  const fullRows = await db
    .select({
      id: opportunities.id,
      listingId: opportunities.listingId,
      productId: opportunities.productId,
      listingPriceUsd: opportunities.listingPriceUsd,
      marketPriceUsd: opportunities.marketPriceUsd,
      profitUsd: opportunities.profitUsd,
      marginPct: opportunities.marginPct,
      potentialProfitUsd: opportunities.potentialProfitUsd,
      potentialMarginPct: opportunities.potentialMarginPct,
      status: opportunities.status,
      flags: opportunities.flags,
      foundAt: opportunities.foundAt,
      confidence: opportunities.confidence,
      feesUsd: opportunities.feesUsd,
      marketPriceCondition: opportunities.marketPriceCondition,
      marketPriceSource: opportunities.marketPriceSource,
      listingTitle: listings.title,
      listingIsLot: listings.isLot,
      listingTotalPrice: listings.priceUsd,
      listingShipping: listings.shippingUsd,
      url: listings.url,
      marketplaceName: marketplaces.name,
      productTitle: products.title,
      productPlatform: products.platform,
    })
    .from(opportunities)
    .innerJoin(listings, eq(opportunities.listingId, listings.id))
    .innerJoin(marketplaces, eq(listings.marketplaceId, marketplaces.id))
    .leftJoin(products, eq(opportunities.productId, products.id))
    .orderBy(desc(opportunities.foundAt))
    .limit(500);

  // Get lot items for all listings
  const listingIds = [...new Set(fullRows.map((r) => r.listingId))];
  const allLotItems = listingIds.length > 0
    ? await db
        .select({
          listingId: listingItems.listingId,
          productId: listingItems.productId,
          condition: listingItems.condition,
          conditionDetails: listingItems.conditionDetails,
          estimatedValueUsd: listingItems.estimatedValueUsd,
          confidence: listingItems.confidence,
          productTitle: products.title,
          productPlatform: products.platform,
        })
        .from(listingItems)
        .leftJoin(products, eq(listingItems.productId, products.id))
    : [];

  const lotItemsByListing = new Map<number, LotItem[]>();
  for (const item of allLotItems) {
    const existing = lotItemsByListing.get(item.listingId) ?? [];
    existing.push({
      productTitle: item.productTitle ?? "Unknown",
      productPlatform: item.productPlatform ?? "",
      condition: item.condition,
      conditionDetails: item.conditionDetails as Record<string, unknown>,
      estimatedValueUsd: item.estimatedValueUsd ?? 0,
      confidence: item.confidence,
    });
    lotItemsByListing.set(item.listingId, existing);
  }

  // Get price comparisons for all products
  const productIds = [...new Set(fullRows.map((r) => r.productId))];
  const allPrices = productIds.length > 0
    ? await db
        .select({
          productId: pricePoints.productId,
          source: pricePoints.source,
          condition: pricePoints.condition,
          priceUsd: pricePoints.priceUsd,
          recordedAt: pricePoints.recordedAt,
        })
        .from(pricePoints)
    : [];

  const pricesByProduct = new Map<string, PriceComparison[]>();
  for (const pp of allPrices) {
    const existing = pricesByProduct.get(pp.productId) ?? [];
    existing.push({
      source: pp.source,
      condition: pp.condition,
      priceUsd: pp.priceUsd,
      recordedAt: pp.recordedAt,
    });
    pricesByProduct.set(pp.productId, existing);
  }

  const tableRows: OpportunityRow[] = fullRows.map((r) => ({
    id: r.id,
    productId: r.productId,
    listingTitle: r.listingTitle,
    productTitle: r.productTitle ?? r.listingTitle,
    productPlatform: r.productPlatform ?? "",
    marketplaceName: r.marketplaceName,
    listingPriceUsd: r.listingPriceUsd,
    listingTotalPrice: r.listingTotalPrice,
    listingShipping: r.listingShipping,
    marketPriceUsd: r.marketPriceUsd,
    profitUsd: r.profitUsd,
    marginPct: r.marginPct,
    potentialProfitUsd: r.potentialProfitUsd,
    potentialMarginPct: r.potentialMarginPct,
    status: r.status,
    flags: r.flags as string[],
    foundAt: r.foundAt,
    url: r.url,
    condition: lotItemsByListing.get(r.listingId)?.[0]?.condition ?? "unknown",
    confidence: r.confidence,
    marketPriceCondition: r.marketPriceCondition,
    marketPriceSource: r.marketPriceSource,
    feesUsd: r.feesUsd,
    isLot: r.listingIsLot ?? false,
    lotItems: lotItemsByListing.get(r.listingId) ?? [],
    priceComparisons: pricesByProduct.get(r.productId) ?? [],
  }));

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Opportunities</h2>
        <p className="text-muted-foreground text-sm mt-0.5">
          Underpriced listings across all marketplaces
        </p>
      </div>
      <OpportunitiesTable rows={tableRows} />
    </div>
  );
}
