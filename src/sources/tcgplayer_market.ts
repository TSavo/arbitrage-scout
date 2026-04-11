/**
 * TCGPlayer marketplace search adapter.
 *
 * Uses TCGPlayer's public search API (mp-search-api.tcgplayer.com) to find
 * products for sale across all TCG categories (Pokemon, MTG, Yu-Gi-Oh, etc).
 *
 * The API returns product-level results with market price, lowest price,
 * lowest price with shipping, and total listing counts. No authentication
 * is required.
 *
 * Rate limited to 1 request per second to be polite.
 */

import { log, error } from "@/lib/logger";
import type { IMarketplaceAdapter, RawListing } from "./IMarketplaceAdapter";
import { makeRawListing } from "./IMarketplaceAdapter";

const SEARCH_URL =
  "https://mp-search-api.tcgplayer.com/v1/search/request?q={QUERY}&isList=false";

const RATE_LIMIT_MS = 1000;
const DEFAULT_LIMIT = 24;
const MAX_SIZE = 100; // API hard cap per request

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/** Shape of a single product result from the search API. */
interface TcgSearchResult {
  productId: number;
  productName: string;
  productUrlName: string;
  productLineUrlName: string;
  productLineName: string;
  setName: string;
  setUrlName: string;
  setId: number;
  marketPrice: number | null;
  lowestPrice: number | null;
  lowestPriceWithShipping: number | null;
  medianPrice: number | null;
  totalListings: number;
  sealed: boolean;
  foilOnly: boolean;
  score: number;
  customAttributes: {
    number?: string | null;
    description?: string | null;
    rarityDbName?: string | null;
    releaseDate?: string | null;
    energyType?: string | null;
    cardType?: string[] | null;
    [key: string]: unknown;
  };
}

export class TcgPlayerMarketAdapter implements IMarketplaceAdapter {
  marketplace_id = "tcgplayer";
  private lastCallAt = 0;

  discoveryQueries(): string[] {
    return [
      // Pokemon
      "charizard",
      "pikachu",
      "mewtwo",
      "pokemon booster box",
      "pokemon elite trainer box",
      // Magic: The Gathering
      "black lotus",
      "magic the gathering booster",
      "mtg commander deck",
      "liliana",
      "jace",
      // Yu-Gi-Oh
      "blue eyes white dragon",
      "dark magician",
      "yugioh booster box",
      // One Piece
      "one piece tcg booster",
      // Lorcana
      "lorcana booster",
      // General high-value
      "graded card psa 10",
      "sealed booster box",
    ];
  }

  isAvailable(): boolean {
    return true; // No auth needed
  }

  async search(
    query: string,
    options: { max_price?: number; limit?: number } = {},
  ): Promise<RawListing[]> {
    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_SIZE);
    log("tcgplayer-market", `searching: "${query}" limit=${limit}`);

    const url = SEARCH_URL.replace("{QUERY}", encodeURIComponent(query));

    const body = {
      algorithm: "revenue_synonym_v2",
      from: 0,
      size: limit,
      filters: {
        term: {} as Record<string, unknown>,
        range: {} as Record<string, unknown>,
        match: {},
      },
      listingSearch: {
        context: { cart: {} },
        filters: {
          term: { sellerStatus: "Live", channelId: 0 },
          range: {
            directLowPrice: { gte: 0 },
          } as Record<string, unknown>,
          exclude: { channelExclusion: 0 },
        },
      },
      context: {
        cart: {},
        shippingCountry: "US",
        userProfile: {},
      },
    };

    // Apply max price filter at the API level
    if (options.max_price) {
      body.listingSearch.filters.range.directLowPrice = {
        gte: 0,
        lte: options.max_price,
      };
    }

    await this.rateLimit();

    const t0 = Date.now();
    let resp: Response;
    try {
      resp = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      error("tcgplayer-market", `fetch failed for "${query}"`, err);
      return [];
    }

    if (!resp.ok) {
      error(
        "tcgplayer-market",
        `search "${query}" HTTP ${resp.status} elapsed=${Date.now() - t0}ms`,
      );
      return [];
    }

    let data: {
      errors: unknown[];
      results: Array<{
        totalResults: number;
        results: TcgSearchResult[];
      }>;
    };

    try {
      data = (await resp.json()) as typeof data;
    } catch (err) {
      error("tcgplayer-market", `JSON parse failed for "${query}"`, err);
      return [];
    }

    const elapsed = Date.now() - t0;

    if (!data.results?.[0]?.results) {
      log("tcgplayer-market", `search "${query}" returned no results (${elapsed}ms)`);
      return [];
    }

    const products = data.results[0].results;
    log(
      "tcgplayer-market",
      `search "${query}": ${products.length} products (${elapsed}ms)`,
    );

    let listings = products
      .filter((p) => {
        // Must have a price
        const price = p.lowestPrice ?? p.marketPrice;
        return price !== null && price > 0;
      })
      .map((p): RawListing => {
        const price = p.lowestPrice ?? p.marketPrice ?? 0;
        const shippingDelta =
          p.lowestPriceWithShipping && p.lowestPrice
            ? Math.max(0, p.lowestPriceWithShipping - p.lowestPrice)
            : 0;

        const productUrl = `https://www.tcgplayer.com/product/${p.productId}/${encodeURIComponent(p.productUrlName)}`;
        const imageUrl = `https://tcgplayer-cdn.tcgplayer.com/product/${p.productId}_200w.jpg`;

        // Build a condition string from card attributes
        const rarity = p.customAttributes?.rarityDbName;
        const conditionParts: string[] = [];
        if (rarity) conditionParts.push(rarity);
        if (p.foilOnly) conditionParts.push("Foil");
        if (p.sealed) conditionParts.push("Sealed");

        return makeRawListing({
          marketplace_id: "tcgplayer",
          listing_id: String(p.productId),
          title: p.productName,
          price_usd: price,
          shipping_usd: shippingDelta,
          url: productUrl,
          description: stripHtml(p.customAttributes?.description ?? ""),
          condition_raw: conditionParts.join(", ") || undefined,
          category_raw: `${p.productLineName} > ${p.setName}`,
          image_url: imageUrl,
          extra: {
            market_price: p.marketPrice,
            median_price: p.medianPrice,
            lowest_price: p.lowestPrice,
            lowest_price_with_shipping: p.lowestPriceWithShipping,
            total_listings: p.totalListings,
            product_line: p.productLineName,
            set_name: p.setName,
            set_id: p.setId,
            sealed: p.sealed,
            foil_only: p.foilOnly,
            card_number: p.customAttributes?.number,
            rarity: p.customAttributes?.rarityDbName,
            release_date: p.customAttributes?.releaseDate,
          },
        });
      });

    // Client-side max_price filter (belt-and-suspenders with the API filter)
    if (options.max_price) {
      listings = listings.filter(
        (l) => l.price_usd + l.shipping_usd <= options.max_price!,
      );
    }

    return listings;
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, RATE_LIMIT_MS - elapsed),
      );
    }
    this.lastCallAt = Date.now();
  }
}

/** Strip HTML tags from a string. */
function stripHtml(html: string): string {
  if (!html) return "";
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
