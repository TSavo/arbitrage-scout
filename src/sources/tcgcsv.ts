/**
 * TCGCSV connector — free TCGplayer price data mirror.
 * Ported from tcgcsv.py.
 *
 * No auth required. Updates daily ~20:00 UTC.
 * Provides categories, groups, products, and prices for 89+ TCGs.
 *
 * Docs: https://tcgcsv.com
 */

import { log, error } from "@/lib/logger";
import { cachedFetch } from "@/lib/cached_fetch";

const TCGCSV_BASE = "https://tcgcsv.com/tcgplayer";

/** Key TCGplayer category IDs */
export const CATEGORIES: Record<string, number> = {
  pokemon: 3,
  mtg: 1,
  yugioh: 2,
  one_piece: 68,
  lorcana: 88,
  sports: 38,
};

export interface TcgProductWithPrice {
  productId: number;
  name: string;
  groupName: string;
  subTypeName: string;
  marketPrice: number | null;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
}

async function _getJson(url: string): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const res = await cachedFetch(
    url,
    { headers: { "User-Agent": "arbitrage-scout-ts/1.0" } },
    { ttlMs: 12 * 60 * 60 * 1000, cacheTag: "tcgcsv-ref" },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const data = res.json<Record<string, unknown>>();
  log("tcgcsv", `GET ${url} elapsed=${Date.now() - t0}ms`);
  return data;
}

/** Free TCGplayer data via TCGCSV mirror. No auth required. */
export class TcgCsvSource {
  /** Fetch all available TCG categories. */
  async getCategories(): Promise<Record<string, unknown>[]> {
    log("tcgcsv", "fetching categories");
    try {
      const data = await _getJson(`${TCGCSV_BASE}/categories`);
      const results = (data.results as Record<string, unknown>[]) ?? [];
      log("tcgcsv", `categories → ${results.length} categories`);
      return results;
    } catch (err) {
      error("tcgcsv", "categories fetch failed", err);
      return [];
    }
  }

  /** Get all sets/groups for a category (e.g. all Pokémon sets). */
  async getGroups(categoryId: number): Promise<Record<string, unknown>[]> {
    log("tcgcsv", `fetching groups for categoryId=${categoryId}`);
    try {
      const data = await _getJson(`${TCGCSV_BASE}/${categoryId}/groups`);
      const results = (data.results as Record<string, unknown>[]) ?? [];
      log("tcgcsv", `groups categoryId=${categoryId} → ${results.length} groups`);
      return results;
    } catch (err) {
      error("tcgcsv", `groups categoryId=${categoryId} fetch failed`, err);
      return [];
    }
  }

  /** Get all products in a group (e.g. all cards in Base Set). */
  async getProducts(categoryId: number, groupId: number): Promise<Record<string, unknown>[]> {
    log("tcgcsv", `fetching products categoryId=${categoryId} groupId=${groupId}`);
    try {
      const data = await _getJson(`${TCGCSV_BASE}/${categoryId}/${groupId}/products`);
      const results = (data.results as Record<string, unknown>[]) ?? [];
      log("tcgcsv", `products ${categoryId}/${groupId} → ${results.length} products`);
      return results;
    } catch (err) {
      error("tcgcsv", `products ${categoryId}/${groupId} fetch failed`, err);
      return [];
    }
  }

  /**
   * Get all prices in a group.
   *
   * Returns list of dicts with productId, subTypeName (Normal/Holofoil/etc),
   * marketPrice, lowPrice, midPrice, highPrice, directLowPrice.
   */
  async getPrices(categoryId: number, groupId: number): Promise<Record<string, unknown>[]> {
    log("tcgcsv", `fetching prices categoryId=${categoryId} groupId=${groupId}`);
    try {
      const data = await _getJson(`${TCGCSV_BASE}/${categoryId}/${groupId}/prices`);
      const results = (data.results as Record<string, unknown>[]) ?? [];
      log("tcgcsv", `prices ${categoryId}/${groupId} → ${results.length} price rows`);
      return results;
    } catch (err) {
      error("tcgcsv", `prices ${categoryId}/${groupId} fetch failed`, err);
      return [];
    }
  }

  /**
   * Join products and prices by productId.
   *
   * Returns combined records with name, productId, marketPrice, lowPrice, subTypeName.
   */
  async getProductsAndPrices(categoryId: number, groupId: number): Promise<TcgProductWithPrice[]> {
    log("tcgcsv", `getProductsAndPrices categoryId=${categoryId} groupId=${groupId}`);
    const t0 = Date.now();
    const [products, prices] = await Promise.all([
      this.getProducts(categoryId, groupId),
      this.getPrices(categoryId, groupId),
    ]);

    const productMap = new Map(
      products.map((p) => [p.productId as number, p]),
    );

    const joined = prices.map((price) => {
      const pid = price.productId as number;
      const product = productMap.get(pid) ?? {};
      return {
        productId: pid,
        name: (product.name as string | undefined) ?? "",
        groupName: (product.groupName as string | undefined) ?? "",
        subTypeName: (price.subTypeName as string | undefined) ?? "",
        marketPrice: (price.marketPrice as number | null) ?? null,
        lowPrice: (price.lowPrice as number | null) ?? null,
        midPrice: (price.midPrice as number | null) ?? null,
        highPrice: (price.highPrice as number | null) ?? null,
      };
    });
    log("tcgcsv", `getProductsAndPrices ${categoryId}/${groupId} → ${joined.length} combined rows elapsed=${Date.now() - t0}ms`);
    return joined;
  }
}
