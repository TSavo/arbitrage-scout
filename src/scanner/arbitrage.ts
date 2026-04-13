/**
 * Cross-marketplace arbitrage: find the same product listed at different
 * prices on different marketplaces. Buy low, sell high.
 */

import { pricePointRepo } from "@/db/repos/PricePointRepo";
import { productRepo } from "@/db/repos/ProductRepo";
import { listingRepo } from "@/db/repos/ListingRepo";
import { db } from "@/db/client";
import { listingItems, listings, products, pricePoints } from "@/db/schema";
import { and, eq, sql, desc } from "drizzle-orm";
import { log, section, hit } from "@/lib/logger";

export interface ArbitrageOpportunity {
  productId: string;
  title: string;
  platform: string;
  // Buy side
  buyMarketplace: string;
  buyListingId: number;
  buyPrice: number;
  buyUrl: string | null;
  buyCondition: string;
  // Sell side
  sellMarketplace: string;
  sellPrice: number;
  sellSource: string; // "listing" or "market_price"
  // Spread
  profitUsd: number;
  marginPct: number;
}

/**
 * Find products that are cheaper on one marketplace than another.
 *
 * Compares active listings against:
 * 1. Active listings on OTHER marketplaces for the same product
 * 2. Market prices (PriceCharting/Scryfall) for the same product + condition
 */
export async function findCrossMarketplaceDeals(
  opts: {
    minProfit?: number;
    minMargin?: number;
    feeRate?: number;
  } = {},
): Promise<ArbitrageOpportunity[]> {
  const minProfit = opts.minProfit ?? 15;
  const minMargin = opts.minMargin ?? 0.2;
  const feeRate = opts.feeRate ?? 0.15; // ~15% selling fees

  section("CROSS-MARKETPLACE ARBITRAGE");

  const deals: ArbitrageOpportunity[] = [];

  // Strategy 1: Listing vs market price
  // Find active listings where the listing price is below the catalog price
  const listingVsMarket = await db
    .select({
      listingId: listingItems.listingId,
      productId: listingItems.productId,
      condition: listingItems.condition,
      confirmed: listingItems.confirmed,
      estimatedValueUsd: listingItems.estimatedValueUsd,
      confidence: listingItems.confidence,
      marketplaceId: listings.marketplaceId,
      listingPrice: listings.priceUsd,
      shippingUsd: listings.shippingUsd,
      listingTitle: listings.title,
      url: listings.url,
      isLot: listings.isLot,
      productTitle: products.title,
      platform: products.platform,
      marketPrice: pricePoints.priceUsd,
      priceSource: pricePoints.source,
    })
    .from(listingItems)
    .innerJoin(listings, eq(listings.id, listingItems.listingId))
    .innerJoin(products, eq(products.id, listingItems.productId))
    .innerJoin(
      pricePoints,
      and(
        eq(pricePoints.productId, listingItems.productId),
        eq(pricePoints.condition, listingItems.condition),
      ),
    )
    .where(
      and(
        eq(listingItems.confirmed, true),
        eq(listings.isActive, true),
        sql`${pricePoints.priceUsd} > 0`,
      ),
    )
    .orderBy(desc(sql`${pricePoints.priceUsd} - ${listings.priceUsd}`));

  for (const row of listingVsMarket) {
    const buyCost = row.listingPrice + row.shippingUsd;
    const sellPrice = row.marketPrice;
    const afterFees = sellPrice * (1 - feeRate);
    const profit = afterFees - buyCost - 5; // $5 shipping out
    const margin = buyCost > 0 ? profit / buyCost : 0;

    if (profit >= minProfit && margin >= minMargin) {
      deals.push({
        productId: row.productId,
        title: row.productTitle,
        platform: row.platform ?? "",
        buyMarketplace: row.marketplaceId,
        buyListingId: row.listingId,
        buyPrice: buyCost,
        buyUrl: row.url,
        buyCondition: row.condition,
        sellMarketplace: row.priceSource,
        sellPrice,
        sellSource: "market_price",
        profitUsd: profit,
        marginPct: margin,
      });
    }
  }

  // Strategy 2: Listing vs listing on different marketplace
  // Same confirmed product, different marketplaces, price gap
  const liBuy = listingItems;
  const listingVsListing = await db
    .select({
      buyListingId: listingItems.listingId,
      productId: listingItems.productId,
      condition: listingItems.condition,
      buyMarketplace: listings.marketplaceId,
      buyPrice: listings.priceUsd,
      buyShipping: listings.shippingUsd,
      buyUrl: listings.url,
      sellListingId: sql<number>`li_sell.listing_id`,
      sellMarketplace: sql<string>`l_sell.marketplace_id`,
      sellPrice: sql<number>`l_sell.price_usd`,
      productTitle: products.title,
      platform: products.platform,
    })
    .from(listingItems)
    .innerJoin(listings, eq(listings.id, listingItems.listingId))
    .innerJoin(
      sql`listing_items li_sell`,
      and(
        sql`li_sell.product_id = ${listingItems.productId}`,
        sql`li_sell.condition = ${listingItems.condition}`,
        sql`li_sell.listing_id != ${listingItems.listingId}`,
      ),
    )
    .innerJoin(
      sql`listings l_sell`,
      and(
        sql`l_sell.id = li_sell.listing_id`,
        sql`l_sell.marketplace_id != ${listings.marketplaceId}`,
      ),
    )
    .innerJoin(products, eq(products.id, listingItems.productId))
    .where(
      and(
        eq(listingItems.confirmed, true),
        sql`li_sell.confirmed = TRUE`,
        eq(listings.isActive, true),
        sql`l_sell.is_active = TRUE`,
        sql`l_sell.price_usd > ${listings.priceUsd}`,
      ),
    )
    .orderBy(desc(sql`l_sell.price_usd - ${listings.priceUsd}`));

  for (const row of listingVsListing) {
    const buyCost = row.buyPrice + row.buyShipping;
    const afterFees = row.sellPrice * (1 - feeRate);
    const profit = afterFees - buyCost - 5;
    const margin = buyCost > 0 ? profit / buyCost : 0;

    if (profit >= minProfit && margin >= minMargin) {
      // Dedupe against strategy 1
      if (!deals.some((d) => d.buyListingId === row.buyListingId && d.productId === row.productId)) {
        deals.push({
          productId: row.productId,
          title: row.productTitle,
          platform: row.platform ?? "",
          buyMarketplace: row.buyMarketplace,
          buyListingId: row.buyListingId,
          buyPrice: buyCost,
          buyUrl: row.buyUrl,
          buyCondition: row.condition,
          sellMarketplace: row.sellMarketplace,
          sellPrice: row.sellPrice,
          sellSource: "listing",
          profitUsd: profit,
          marginPct: margin,
        });
      }
    }
  }

  deals.sort((a, b) => b.profitUsd - a.profitUsd);

  log("arbitrage", `${deals.length} cross-marketplace deals found`);
  for (const d of deals.slice(0, 15)) {
    hit(
      "arbitrage",
      `${d.title} (${d.platform}) [${d.buyCondition}] — buy on ${d.buyMarketplace} @ $${d.buyPrice.toFixed(2)}, sell on ${d.sellMarketplace} @ $${d.sellPrice.toFixed(2)} → $${d.profitUsd.toFixed(2)} profit (${(d.marginPct * 100).toFixed(0)}%)`,
    );
  }

  return deals;
}
