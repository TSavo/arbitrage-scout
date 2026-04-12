/**
 * eBay adapter — OAuth client credentials + Browse API (live listings).
 * Ported from ebay.py + ebay_adapter.py.
 *
 * Auth: Application-level OAuth2 (client_credentials grant).
 * Search: Browse API /buy/browse/v1/item_summary/search.
 * Sold comps: Finding API findCompletedItems (app_id header, no OAuth).
 */

import { IMarketplaceAdapter, RawListing, makeRawListing } from "./IMarketplaceAdapter";
import { log, error } from "@/lib/logger";
import { cachedFetch } from "@/lib/cached_fetch";

const EBAY_SEARCH_TTL_MS = 10 * 60 * 1000; // 10 min — search results churn
const EBAY_DETAIL_TTL_MS = null; // listings are immutable once seen

const PROD_API_BASE = "https://api.ebay.com";
const SANDBOX_API_BASE = "https://api.sandbox.ebay.com";
const FINDING_API_URL = "https://svcs.ebay.com/services/search/FindingService/v1";
const DEFAULT_SCOPE = "https://api.ebay.com/oauth/api_scope";
/** eBay tokens live 7200s; refresh a bit early */
const TOKEN_TTL_MS = 7100 * 1000;

export interface SoldItem {
  item_id: string;
  title: string;
  price_usd: number;
  shipping_usd: number;
  condition_raw: string;
  sold_at: Date;
  url?: string;
}

interface CachedToken {
  access_token: string;
  expires_at: number;
}

export interface EbayConfig {
  app_id: string;
  cert_id: string;
  env?: "production" | "sandbox";
  marketplace?: string;
}

export class EbayAdapter implements IMarketplaceAdapter {
  readonly marketplace_id = "ebay";

  private readonly _appId: string;
  private readonly _certId: string;
  private readonly _base: string;
  private readonly _marketplace: string;
  private _cachedToken: CachedToken | null = null;
  private _rateLimited = false;

  constructor(cfg: EbayConfig) {
    this._appId = cfg.app_id;
    this._certId = cfg.cert_id;
    this._base = cfg.env === "sandbox" ? SANDBOX_API_BASE : PROD_API_BASE;
    this._marketplace = cfg.marketplace ?? "EBAY_US";
  }

  // ------------------------------------------------------------
  // OAuth
  // ------------------------------------------------------------

  /** Single-flight token fetch. Multiple concurrent searches share one call. */
  private _tokenInFlight: Promise<string> | null = null;

  private async _getToken(): Promise<string> {
    const now = Date.now();
    if (this._cachedToken && now < this._cachedToken.expires_at) {
      return this._cachedToken.access_token;
    }
    // If another caller is already fetching, piggy-back on their promise.
    if (this._tokenInFlight) return this._tokenInFlight;

    this._tokenInFlight = this._fetchToken().finally(() => {
      this._tokenInFlight = null;
    });
    return this._tokenInFlight;
  }

  private async _fetchToken(): Promise<string> {
    log("ebay", `acquiring OAuth token from ${this._base}`);
    const t0 = Date.now();
    const creds = Buffer.from(`${this._appId}:${this._certId}`).toString("base64");
    const res = await fetch(`${this._base}/identity/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        scope: DEFAULT_SCOPE,
      }),
    });

    if (!res.ok) {
      error("ebay", `OAuth failed: ${res.status} ${res.statusText} (${Date.now() - t0}ms)`);
      throw new Error(`eBay OAuth failed: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as { access_token: string; expires_in: number };
    this._cachedToken = {
      access_token: data.access_token,
      expires_at: Date.now() + TOKEN_TTL_MS,
    };
    log("ebay", `OAuth token acquired expires_in=${data.expires_in}s elapsed=${Date.now() - t0}ms`);
    return data.access_token;
  }

  private async _authHeaders(): Promise<Record<string, string>> {
    return {
      Authorization: `Bearer ${await this._getToken()}`,
      "X-EBAY-C-MARKETPLACE-ID": this._marketplace,
    };
  }

  // ------------------------------------------------------------
  // IMarketplaceAdapter
  // ------------------------------------------------------------

  discoveryQueries(): string[] {
    return [
      "retro video game lot",
      "n64 game",
      "snes game",
      "gamecube game",
      "ps1 game",
      "ps2 game",
      "pokemon tcg card",
      "pokemon card lot",
      "mtg card lot",
      "magic the gathering",
      "baseball card lot",
      "football card lot",
      "basketball card lot",
    ];
  }

  async search(
    query: string,
    options: { max_price?: number; limit?: number } = {},
  ): Promise<RawListing[]> {
    if (this._rateLimited) {
      log("ebay", `search skipped (rate limited): ${JSON.stringify(query)}`);
      return [];
    }

    const limit = options.limit ?? 25;
    const max_price = options.max_price;

    log("ebay", `search query=${JSON.stringify(query)} limit=${limit}${max_price != null ? ` max_price=${max_price}` : ""}`);
    try {
      const items = await this._searchListings(query, { limit, max_price });
      const listings = items.map(_itemToRawListing).filter((x): x is RawListing => x !== null);
      log("ebay", `search "${query}" → ${listings.length} listings`);
      return listings;
    } catch (err) {
      const msg = String(err);
      if (msg.includes("429")) {
        error("ebay", "rate limited — pausing adapter");
        this._rateLimited = true;
        return [];
      }
      error("ebay", `search ${JSON.stringify(query)} failed`, err);
      return [];
    }
  }

  isAvailable(): boolean {
    return !this._rateLimited;
  }

  // ------------------------------------------------------------
  // Browse API — live listings
  // ------------------------------------------------------------

  async searchListings(
    query: string,
    options: { limit?: number; max_price?: number; sort?: string } = {},
  ): Promise<RawListing[]> {
    const items = await this._searchListings(query, options);
    return items.map(_itemToRawListing).filter((x): x is RawListing => x !== null);
  }

  private async _searchListings(
    query: string,
    options: { limit?: number; max_price?: number; sort?: string },
  ): Promise<Record<string, unknown>[]> {
    const limit = Math.min(options.limit ?? 50, 200);
    const sort = options.sort ?? "price";

    const params = new URLSearchParams({ q: query, limit: String(limit), sort });
    if (options.max_price != null) {
      params.set("filter", `price:[..${options.max_price.toFixed(2)}],priceCurrency:USD`);
    }

    const headers = await this._authHeaders();
    const t0 = Date.now();
    const res = await cachedFetch(
      `${this._base}/buy/browse/v1/item_summary/search?${params}`,
      { headers },
      { ttlMs: EBAY_SEARCH_TTL_MS, cacheTag: "ebay-search" },
    );

    if (!res.ok) {
      if (res.status === 429) error("ebay", `Browse API rate limited (429) elapsed=${Date.now() - t0}ms`);
      throw new Error(`eBay Browse API ${res.status}`);
    }

    const data = res.json<{ itemSummaries?: Record<string, unknown>[] }>();
    const items = data.itemSummaries ?? [];
    log("ebay", `Browse API returned ${items.length} items elapsed=${Date.now() - t0}ms fromCache=${res.fromCache}`);
    return items;
  }

  /** Fetch full item description via Browse API getItem. */
  async getItemDescription(itemId: string): Promise<string | null> {
    const t0 = Date.now();
    log("ebay", `fetching description for itemId=${itemId}`);
    try {
      const headers = await this._authHeaders();
      const res = await cachedFetch(
        `${this._base}/buy/browse/v1/item/v1|${itemId}|0`,
        { headers },
        { ttlMs: EBAY_DETAIL_TTL_MS, cacheTag: "ebay-detail" },
      );
      if (!res.ok) {
        error("ebay", `getItemDescription ${itemId} HTTP ${res.status} (${Date.now() - t0}ms)`);
        return null;
      }
      const data = res.json<Record<string, unknown>>();
      let desc = (data.description as string | undefined) ??
        (data.shortDescription as string | undefined) ?? "";
      if (desc) {
        desc = desc.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      }
      log("ebay", `description ${itemId} len=${desc.length} elapsed=${Date.now() - t0}ms`);
      return desc || null;
    } catch (err) {
      error("ebay", `getItemDescription ${itemId} failed`, err);
      return null;
    }
  }

  // ------------------------------------------------------------
  // Finding API — sold/completed listings
  // ------------------------------------------------------------

  async searchSold(query: string, options: { limit?: number } = {}): Promise<SoldItem[]> {
    const limit = Math.min(options.limit ?? 100, 100);
    log("ebay", `searchSold query=${JSON.stringify(query)} limit=${limit}`);
    const t0 = Date.now();
    const encodedKw = encodeURIComponent(query);
    const url =
      `${FINDING_API_URL}` +
      `?OPERATION-NAME=findCompletedItems` +
      `&SERVICE-VERSION=1.13.0` +
      `&SECURITY-APPNAME=${this._appId}` +
      `&RESPONSE-DATA-FORMAT=JSON` +
      `&REST-PAYLOAD` +
      `&keywords=${encodedKw}` +
      `&paginationInput.entriesPerPage=${limit}` +
      `&itemFilter(0).name=SoldItemsOnly` +
      `&itemFilter(0).value=true` +
      `&sortOrder=EndTimeSoonest`;

    try {
      const res = await cachedFetch(url, {}, { ttlMs: EBAY_SEARCH_TTL_MS, cacheTag: "ebay-sold" });
      if (!res.ok) {
        error("ebay", `Finding API HTTP ${res.status} for ${JSON.stringify(query)} — likely rate-limited (${Date.now() - t0}ms)`);
        return [];
      }
      const data = res.json<Record<string, unknown>>();

      if ("errorMessage" in data) {
        const errors = ((data.errorMessage as unknown[])[0] as Record<string, unknown[]>).error ?? [];
        const msg = errors.length
          ? ((errors[0] as Record<string, string[]>).message?.[0] ?? "unknown")
          : "unknown";
        error("ebay", `Finding API error: ${msg}`);
        return [];
      }

      const items = _extractFindingItems(data);
      const sold = items.map(_findingItemToSold).filter((x): x is SoldItem => x !== null);
      log("ebay", `searchSold "${query}" → ${sold.length} sold items elapsed=${Date.now() - t0}ms`);
      return sold;
    } catch (err) {
      error("ebay", `Finding API request failed for ${JSON.stringify(query)}`, err);
      return [];
    }
  }
}

// ------------------------------------------------------------
// Browse API mapping helpers
// ------------------------------------------------------------

function _itemToRawListing(item: Record<string, unknown>): RawListing | null {
  try {
    const price = (item.price as Record<string, string> | undefined) ?? {};
    if (price.currency !== "USD") return null;

    const shippingUsd = _extractShipping(item);
    const extra = item.extra as Record<string, unknown> | undefined;
    const categories = ((item.categories as Record<string, string>[] | undefined) ?? [])
      .map((c) => c.categoryName)
      .filter(Boolean);
    const seller = (item.seller as Record<string, string> | undefined)?.username;
    const image = (item.image as Record<string, string> | undefined)?.imageUrl;
    const buyingOptions = item.buyingOptions;

    return makeRawListing({
      marketplace_id: "ebay",
      listing_id: String(item.itemId),
      title: (item.title as string | undefined) ?? "",
      price_usd: parseFloat(price.value),
      shipping_usd: shippingUsd,
      url: item.itemWebUrl as string | undefined,
      condition_raw: item.condition as string | undefined,
      category_raw: categories[0],
      image_url: image,
      seller,
      extra: {
        categories,
        seller,
        buying_options: buyingOptions,
        image,
        ...(typeof extra === "object" && extra !== null ? extra : {}),
      },
    });
  } catch {
    return null;
  }
}

function _extractShipping(item: Record<string, unknown>): number {
  const opts = (item.shippingOptions as Record<string, unknown>[] | undefined) ?? [];
  for (const opt of opts) {
    const cost = (opt.shippingCost as Record<string, string> | undefined) ?? {};
    if (cost.currency === "USD") {
      return parseFloat(cost.value ?? "0");
    }
  }
  return 0;
}

// ------------------------------------------------------------
// Finding API mapping helpers
// ------------------------------------------------------------

function _extractFindingItems(response: Record<string, unknown>): Record<string, unknown>[] {
  try {
    const root = ((response.findCompletedItemsResponse as unknown[])?.[0] ?? {}) as Record<string, unknown>;
    const results = ((root.searchResult as unknown[])?.[0] ?? {}) as Record<string, unknown>;
    return (results.item as Record<string, unknown>[]) ?? [];
  } catch {
    return [];
  }
}

function _findingItemToSold(item: Record<string, unknown>): SoldItem | null {
  try {
    const priceInfo = ((item.sellingStatus as unknown[])?.[0] ?? {}) as Record<string, unknown>;
    const priceObj = ((priceInfo.currentPrice as unknown[])?.[0] ?? {}) as Record<string, string>;
    if (priceObj["@currencyId"] !== "USD") return null;
    const priceUsd = parseFloat(priceObj["__value__"] ?? "0");

    let shippingUsd = 0;
    const shipInfo = ((item.shippingInfo as unknown[])?.[0] ?? {}) as Record<string, unknown>;
    const shipCost = ((shipInfo.shippingServiceCost as unknown[])?.[0] ?? {}) as Record<string, string>;
    if (shipCost["@currencyId"] === "USD") {
      shippingUsd = parseFloat(shipCost["__value__"] ?? "0");
    }

    const listingInfo = ((item.listingInfo as unknown[])?.[0] ?? {}) as Record<string, unknown>;
    const endTimeStr = ((listingInfo.endTime as unknown[])?.[0] as string | undefined);
    const soldAt = endTimeStr
      ? new Date(endTimeStr.replace("Z", "+00:00"))
      : new Date();

    const conditionInfo = ((item.condition as unknown[])?.[0] ?? {}) as Record<string, unknown>;
    const conditionRaw = ((conditionInfo.conditionDisplayName as unknown[])?.[0] as string | undefined) ?? "unknown";
    const itemId = ((item.itemId as unknown[])?.[0] as string | undefined) ?? "";
    const title = ((item.title as unknown[])?.[0] as string | undefined) ?? "";
    const url = ((item.viewItemURL as unknown[])?.[0] as string | undefined);

    return {
      item_id: itemId,
      title,
      price_usd: priceUsd,
      shipping_usd: shippingUsd,
      condition_raw: conditionRaw,
      sold_at: soldAt,
      url,
    };
  } catch {
    return null;
  }
}
