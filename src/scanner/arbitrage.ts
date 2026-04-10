/**
 * Cross-marketplace arbitrage: find the same product listed at different
 * prices on different marketplaces. Buy low, sell high.
 */

import Database from "better-sqlite3";
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
export function findCrossMarketplaceDeals(
  sqliteDb: Database.Database,
  opts: {
    minProfit?: number;
    minMargin?: number;
    feeRate?: number;
  } = {},
): ArbitrageOpportunity[] {
  const minProfit = opts.minProfit ?? 15;
  const minMargin = opts.minMargin ?? 0.2;
  const feeRate = opts.feeRate ?? 0.15; // ~15% selling fees

  section("CROSS-MARKETPLACE ARBITRAGE");

  const deals: ArbitrageOpportunity[] = [];

  // Strategy 1: Listing vs market price
  // Find active listings where the listing price is below the catalog price
  const listingVsMarket = sqliteDb
    .prepare(
      `SELECT
         li.listing_id,
         li.product_id,
         li.condition,
         li.confirmed,
         li.estimated_value_usd,
         li.confidence,
         l.marketplace_id,
         l.price_usd as listing_price,
         l.shipping_usd,
         l.title as listing_title,
         l.url,
         l.is_lot,
         p.title as product_title,
         p.platform,
         pp.price_usd as market_price,
         pp.source as price_source
       FROM listing_items li
       JOIN listings l ON l.id = li.listing_id
       JOIN products p ON p.id = li.product_id
       JOIN price_points pp ON pp.product_id = li.product_id
         AND pp.condition = li.condition
       WHERE li.confirmed = 1
         AND l.is_active = 1
         AND pp.price_usd > 0
       ORDER BY (pp.price_usd - l.price_usd) DESC`,
    )
    .all() as Array<{
    listing_id: number;
    product_id: string;
    condition: string;
    confirmed: number;
    estimated_value_usd: number | null;
    confidence: number;
    marketplace_id: string;
    listing_price: number;
    shipping_usd: number;
    listing_title: string;
    url: string | null;
    is_lot: number;
    product_title: string;
    platform: string;
    market_price: number;
    price_source: string;
  }>;

  for (const row of listingVsMarket) {
    const buyCost = row.listing_price + row.shipping_usd;
    // For lots, per-item cost (rough — already stored in estimated_value)
    const sellPrice = row.market_price;
    const afterFees = sellPrice * (1 - feeRate);
    const profit = afterFees - buyCost - 5; // $5 shipping out
    const margin = buyCost > 0 ? profit / buyCost : 0;

    if (profit >= minProfit && margin >= minMargin) {
      deals.push({
        productId: row.product_id,
        title: row.product_title,
        platform: row.platform,
        buyMarketplace: row.marketplace_id,
        buyListingId: row.listing_id,
        buyPrice: buyCost,
        buyUrl: row.url,
        buyCondition: row.condition,
        sellMarketplace: row.price_source,
        sellPrice,
        sellSource: "market_price",
        profitUsd: profit,
        marginPct: margin,
      });
    }
  }

  // Strategy 2: Listing vs listing on different marketplace
  // Same confirmed product, different marketplaces, price gap
  const listingVsListing = sqliteDb
    .prepare(
      `SELECT
         li_buy.listing_id as buy_listing_id,
         li_buy.product_id,
         li_buy.condition,
         l_buy.marketplace_id as buy_marketplace,
         l_buy.price_usd as buy_price,
         l_buy.shipping_usd as buy_shipping,
         l_buy.url as buy_url,
         li_sell.listing_id as sell_listing_id,
         l_sell.marketplace_id as sell_marketplace,
         l_sell.price_usd as sell_price,
         p.title as product_title,
         p.platform
       FROM listing_items li_buy
       JOIN listings l_buy ON l_buy.id = li_buy.listing_id
       JOIN listing_items li_sell ON li_sell.product_id = li_buy.product_id
         AND li_sell.condition = li_buy.condition
         AND li_sell.listing_id != li_buy.listing_id
       JOIN listings l_sell ON l_sell.id = li_sell.listing_id
         AND l_sell.marketplace_id != l_buy.marketplace_id
       JOIN products p ON p.id = li_buy.product_id
       WHERE li_buy.confirmed = 1
         AND li_sell.confirmed = 1
         AND l_buy.is_active = 1
         AND l_sell.is_active = 1
         AND l_sell.price_usd > l_buy.price_usd
       ORDER BY (l_sell.price_usd - l_buy.price_usd) DESC`,
    )
    .all() as Array<{
    buy_listing_id: number;
    product_id: string;
    condition: string;
    buy_marketplace: string;
    buy_price: number;
    buy_shipping: number;
    buy_url: string | null;
    sell_listing_id: number;
    sell_marketplace: string;
    sell_price: number;
    product_title: string;
    platform: string;
  }>;

  for (const row of listingVsListing) {
    const buyCost = row.buy_price + row.buy_shipping;
    const afterFees = row.sell_price * (1 - feeRate);
    const profit = afterFees - buyCost - 5;
    const margin = buyCost > 0 ? profit / buyCost : 0;

    if (profit >= minProfit && margin >= minMargin) {
      // Dedupe against strategy 1
      if (!deals.some((d) => d.buyListingId === row.buy_listing_id && d.productId === row.product_id)) {
        deals.push({
          productId: row.product_id,
          title: row.product_title,
          platform: row.platform,
          buyMarketplace: row.buy_marketplace,
          buyListingId: row.buy_listing_id,
          buyPrice: buyCost,
          buyUrl: row.buy_url,
          buyCondition: row.condition,
          sellMarketplace: row.sell_marketplace,
          sellPrice: row.sell_price,
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
