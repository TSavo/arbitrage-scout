/**
 * PriceCharting adapter — retro game + TCG market prices.
 * Ported from pricecharting.py + pricecharting_adapter.py.
 *
 * Paid API ($40/mo), rate-limited to ~1 req/sec.
 * Docs: https://www.pricecharting.com/api-documentation
 *
 * The adapter uses the /offers endpoint to surface individual marketplace
 * listings, organized by console ID (e.g. "G4" = N64).
 */

import { IMarketplaceAdapter, RawListing, makeRawListing } from "./IMarketplaceAdapter";
import { log, error } from "@/lib/logger";
import { cachedFetch } from "@/lib/cached_fetch";

const PRICECHARTING_API = "https://www.pricecharting.com/api";
/** 1 req/sec limit; pad generously to avoid 403s */
const REQUEST_DELAY_MS = 1500;

export interface PriceChartingConfig {
  api_key: string;
}

export interface PriceInfo {
  product_name: string;
  console: string;
  loose: number;
  cib: number;
  new: number;
  graded: number;
  volume: string;
}

// ------------------------------------------------------------
// Low-level PriceCharting source
// ------------------------------------------------------------

class PriceChartingSource {
  private readonly _apiKey: string;
  private _lastRequest = 0;

  constructor(cfg: PriceChartingConfig) {
    this._apiKey = cfg.api_key;
  }

  private async _rateLimit(): Promise<void> {
    const elapsed = Date.now() - this._lastRequest;
    if (elapsed < REQUEST_DELAY_MS) {
      const delay = REQUEST_DELAY_MS - elapsed;
      log("pricecharting", `rate limit delay ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
    this._lastRequest = Date.now();
  }

  /** Search for products by name. Returns list of product dicts. */
  async search(query: string): Promise<Record<string, unknown>[]> {
    await this._rateLimit();
    log("pricecharting", `search query=${JSON.stringify(query)}`);
    const t0 = Date.now();
    try {
      const params = new URLSearchParams({ t: this._apiKey, q: query });
      const res = await cachedFetch(`${PRICECHARTING_API}/products?${params}`, {}, {
        ttlMs: 10 * 60 * 1000,
        cacheTag: "pricecharting-search",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = res.json<Record<string, unknown>>();
      const products = (data.products as Record<string, unknown>[]) ?? [];
      log("pricecharting", `search "${query}" → ${products.length} results elapsed=${Date.now() - t0}ms`);
      return products;
    } catch (err) {
      error("pricecharting", `search ${JSON.stringify(query)} failed`, err);
      return [];
    }
  }

  /**
   * Look up market price for a product by name.
   * condition: "loose" | "cib" | "new" | "graded"
   * Returns price in USD, or null if not found.
   */
  async getPrice(name: string, condition: "loose" | "cib" | "new" | "graded" = "loose"): Promise<number | null> {
    const products = await this.search(name);
    if (!products.length) return null;

    const product = products[0];
    const priceKey = `${condition}-price`;
    const pricePennies = product[priceKey] as number | undefined;
    if (pricePennies != null && pricePennies > 0) {
      return pricePennies / 100;
    }
    return null;
  }

  /**
   * Get all price points for the best-matching product.
   * Returns loose/cib/new/graded in USD, plus metadata. Null if not found.
   */
  async getAllPrices(name: string): Promise<PriceInfo | null> {
    const products = await this.search(name);
    if (!products.length) return null;

    const p = products[0] as Record<string, unknown>;
    return {
      product_name: (p["product-name"] as string | undefined) ?? "",
      console: (p["console-name"] as string | undefined) ?? "",
      loose: ((p["loose-price"] as number | undefined) ?? 0) / 100,
      cib: ((p["cib-price"] as number | undefined) ?? 0) / 100,
      new: ((p["new-price"] as number | undefined) ?? 0) / 100,
      graded: ((p["graded-price"] as number | undefined) ?? 0) / 100,
      volume: String(p["sales-volume"] ?? "0"),
    };
  }
}

// ------------------------------------------------------------
// IMarketplaceAdapter
// Console IDs used by PriceCharting's /offers endpoint
// ------------------------------------------------------------

const CONSOLES: [string, string][] = [
  ["G4", "N64"],
  ["G13", "SNES"],
  ["G3", "GameCube"],
  ["G17", "NES"],
  ["G6", "PS1"],
  ["G7", "PS2"],
  ["G15", "Genesis"],
  ["G16", "Dreamcast"],
  ["G14", "Saturn"],
  ["G49", "GB"],
  ["G1", "GBA"],
  ["G2", "GBC"],
];

const CONSOLE_MAP = new Map(CONSOLES);

export class PriceChartingAdapter implements IMarketplaceAdapter {
  readonly marketplace_id = "pricecharting";

  private readonly _apiKey: string;
  /** Exposed for callers that want direct price lookups */
  readonly source: PriceChartingSource;

  constructor(cfg: PriceChartingConfig) {
    this._apiKey = cfg.api_key;
    this.source = new PriceChartingSource(cfg);
  }

  discoveryQueries(): string[] {
    // PriceCharting uses console IDs for the /offers endpoint, not keywords
    return CONSOLES.map(([id]) => id);
  }

  /**
   * query is a console ID like "G4" (N64).
   * Fetches available marketplace offers sorted by lowest price.
   */
  async search(
    query: string,
    options: { max_price?: number; limit?: number } = {},
  ): Promise<RawListing[]> {
    const consoleName = CONSOLE_MAP.get(query) ?? query;
    const limit = options.limit ?? 30;
    const max_price = options.max_price;
    log("pricecharting", `offers console=${consoleName} (${query}) limit=${limit}${max_price != null ? ` max_price=${max_price}` : ""}`);
    const t0 = Date.now();
    try {
      const params = new URLSearchParams({
        t: this._apiKey,
        status: "available",
        console: query,
        sort: "lowest-price",
      });

      const res = await cachedFetch(`${PRICECHARTING_API}/offers?${params}`, {}, {
        ttlMs: 10 * 60 * 1000,
        cacheTag: "pricecharting-search",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = res.json<Record<string, unknown>>();
      let offers = (data.offers as Record<string, unknown>[]) ?? [];

      if (max_price != null) {
        offers = offers.filter((o) => {
          const priceUsd = ((o.price as number | undefined) ?? 0) / 100;
          return priceUsd <= max_price;
        });
      }

      const listings = offers.slice(0, limit);
      log("pricecharting", `offers "${consoleName}" → ${listings.length} listings (${offers.length} before limit) elapsed=${Date.now() - t0}ms`);

      return listings.map((o) =>
        makeRawListing({
          marketplace_id: "pricecharting",
          listing_id: String(o["offer-id"] ?? o.id ?? ""),
          title: (o["product-name"] as string | undefined) ?? "",
          price_usd: ((o.price as number | undefined) ?? 0) / 100,
          url: `https://www.pricecharting.com${(o["offer-url"] as string | undefined) ?? ""}`,
          condition_raw: (o["include-string"] as string | undefined) ?? "",
          category_raw: (o["console-name"] as string | undefined) ?? consoleName,
          extra: {
            condition_detail: o["condition-string"],
            pc_product_id: `pc-${o.id ?? ""}`,
            include: o["include-string"],
          },
        }),
      );
    } catch (err) {
      error("pricecharting", `offers ${JSON.stringify(query)} failed`, err);
      return [];
    }
  }

  isAvailable(): boolean {
    return Boolean(this._apiKey);
  }
}
