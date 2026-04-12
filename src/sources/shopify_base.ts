/**
 * Generic Shopify-backed retailer adapter.
 *
 * Public Shopify stores expose:
 *   /collections.json?limit=250              — site's collections + counts
 *   /collections/:handle/products.json       — paginated products in a collection
 *   /products/:handle.json                   — full product JSON (with barcode)
 *
 * Subclass by passing marketplaceId + base URL. Optionally override discovery
 * query handles or the per-product fetch to add store-specific fields.
 */

import {
  IMarketplaceAdapter,
  RawListing,
  makeRawListing,
} from "./IMarketplaceAdapter";
import { cachedFetch } from "@/lib/cached_fetch";
import { log } from "@/lib/logger";

const PAGE_SIZE = 250;
const MAX_PAGES = 40;
const MIN_COLLECTION_SIZE = 30;
const DISCOVERY_TTL_MS = 6 * 60 * 60_000;
const PRODUCT_JSON_TTL_MS = 7 * 24 * 60 * 60_000;

interface ShopifyVariant {
  readonly price?: string;
  readonly sku?: string;
  readonly available?: boolean;
  readonly title?: string;
  readonly barcode?: string | null;
}
interface ShopifyImage { readonly src?: string }
interface ShopifyProduct {
  readonly id: number;
  readonly title: string;
  readonly handle: string;
  readonly body_html?: string;
  readonly vendor?: string;
  readonly product_type?: string;
  readonly tags?: string[];
  readonly variants?: ShopifyVariant[];
  readonly images?: ShopifyImage[];
}
interface ProductsResp { readonly products?: ShopifyProduct[] }

export interface ShopifyAdapterOptions {
  readonly marketplaceId: string;
  /** Full base URL, e.g. "https://www.bittersandbottles.com". No trailing slash. */
  readonly baseUrl: string;
  /** Fallback collection handles when /collections.json is unreachable. */
  readonly fallbackCollections?: readonly string[];
  /** Minimum product count for a collection to be worth scanning. */
  readonly minCollectionSize?: number;
  /** Extra key=>value pairs to drop into RawListing.extra. Override per-store. */
  readonly extraFields?: (p: ShopifyProduct, variant: ShopifyVariant) => Record<string, unknown>;
  /** SKU identifier-type key stored in extra for product_identifiers indexing. */
  readonly skuKey?: string;
}

export class ShopifyAdapter implements IMarketplaceAdapter {
  readonly marketplace_id: string;
  private readonly baseUrl: string;
  private readonly fallback: readonly string[];
  private readonly minSize: number;
  private readonly extraFields: ShopifyAdapterOptions["extraFields"];
  private readonly skuKey: string;
  private cachedQueries: string[] | null = null;
  private discoveryAt = 0;

  constructor(opts: ShopifyAdapterOptions) {
    this.marketplace_id = opts.marketplaceId;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.fallback = opts.fallbackCollections ?? ["all"];
    this.minSize = opts.minCollectionSize ?? MIN_COLLECTION_SIZE;
    this.extraFields = opts.extraFields;
    this.skuKey = opts.skuKey ?? `${opts.marketplaceId}_sku`;
  }

  isAvailable(): boolean {
    return true;
  }

  discoveryQueries(): string[] {
    // Sync interface — return the last snapshot and kick off a refresh in
    // the background. First call returns fallback; subsequent calls return
    // live list.
    if (!this.cachedQueries) {
      this.cachedQueries = [...this.fallback];
      this.refreshCollections();
    } else if (Date.now() - this.discoveryAt > DISCOVERY_TTL_MS) {
      this.refreshCollections();
    }
    return [...this.cachedQueries];
  }

  private refreshCollections(): void {
    this.fetchCollectionHandles()
      .then((handles) => {
        if (handles.length) {
          this.cachedQueries = handles;
          this.discoveryAt = Date.now();
        }
      })
      .catch(() => {});
  }

  private async fetchCollectionHandles(): Promise<string[]> {
    try {
      const resp = await cachedFetch(
        `${this.baseUrl}/collections.json?limit=250`,
        { method: "GET" },
        { ttlMs: DISCOVERY_TTL_MS, cacheTag: `${this.marketplace_id}:collections` },
      );
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = resp.json<{ collections?: Array<{ handle: string; products_count: number }> }>();
      const handles = (data.collections ?? [])
        .filter((c) => c.products_count >= this.minSize)
        .sort((a, b) => b.products_count - a.products_count)
        .map((c) => c.handle);
      log(
        this.marketplace_id,
        `discovered ${handles.length} collections (≥${this.minSize} products)`,
      );
      return handles;
    } catch (err) {
      log(
        this.marketplace_id,
        `collections.json failed (${(err as Error).message}) — using fallback`,
      );
      return [...this.fallback];
    }
  }

  async search(
    query: string,
    options: { max_price?: number; limit?: number } = {},
  ): Promise<RawListing[]> {
    const out: RawListing[] = [];
    for await (const l of this.stream(query, options)) {
      out.push(l);
      if (options.limit && out.length >= options.limit) break;
    }
    return out;
  }

  async *stream(
    query: string,
    options: { max_price?: number; limit?: number } = {},
  ): AsyncIterable<RawListing> {
    let emitted = 0;
    const limit = options.limit ?? Infinity;
    const isCollection = query && query !== "all";
    const pathBase = isCollection
      ? `${this.baseUrl}/collections/${encodeURIComponent(query)}/products.json`
      : `${this.baseUrl}/products.json`;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${pathBase}?limit=${PAGE_SIZE}&page=${page}`;
      const resp = await cachedFetch(
        url,
        { method: "GET" },
        { ttlMs: 6 * 60 * 60_000, cacheTag: `${this.marketplace_id}:${query}` },
      );
      if (!resp.ok) {
        log(
          this.marketplace_id,
          `${query} page ${page} → HTTP ${resp.status}, stopping`,
        );
        break;
      }
      const data = resp.json<ProductsResp>();
      const products = data.products ?? [];
      if (products.length === 0) {
        log(
          this.marketplace_id,
          `${query}: empty page ${page}, stopping (total emitted=${emitted})`,
        );
        break;
      }
      log(this.marketplace_id, `${query} page ${page} → ${products.length} products`);
      for (const p of products) {
        const listing = this.toListing(p);
        if (!listing) continue;
        if (options.max_price != null && listing.price_usd > options.max_price) continue;
        // Per-product fetch to pick up barcode/UPC — the collection API
        // strips it across all Shopify stores.
        const upc = await this.fetchUpc(p.handle);
        if (upc) listing.extra = { ...listing.extra, upc };
        yield listing;
        emitted++;
        if (emitted >= limit) return;
      }
      if (products.length < PAGE_SIZE) break;
    }
  }

  private toListing(p: ShopifyProduct): RawListing | null {
    const variants = p.variants ?? [];
    const available = variants.filter((v) => v.available !== false);
    const pick = available[0] ?? variants[0];
    if (!pick?.price) return null;
    const price = parseFloat(pick.price);
    if (!isFinite(price) || price <= 0) return null;

    const desc = stripHtml(p.body_html ?? "");
    const base: Record<string, unknown> = {
      handle: p.handle,
      tags: p.tags ?? [],
      available: pick.available !== false,
      [this.skuKey]: pick.sku,
    };
    const extra = this.extraFields ? { ...base, ...this.extraFields(p, pick) } : base;

    return makeRawListing({
      marketplace_id: this.marketplace_id,
      listing_id: String(p.id),
      title: p.title,
      price_usd: price,
      shipping_usd: 0,
      url: `${this.baseUrl}/products/${p.handle}`,
      description: desc || undefined,
      image_url: p.images?.[0]?.src,
      seller: p.vendor,
      category_raw: p.product_type,
      extra,
    });
  }

  private async fetchUpc(handle: string): Promise<string | undefined> {
    try {
      const resp = await cachedFetch(
        `${this.baseUrl}/products/${encodeURIComponent(handle)}.json`,
        { method: "GET" },
        {
          ttlMs: PRODUCT_JSON_TTL_MS,
          cacheTag: `${this.marketplace_id}:upc`,
          // Serialize per-store so we never fire two concurrent UPC
          // fetches at the same Shopify host. Pipeline runs all 7 stores
          // in parallel — without this, each host was getting hammered
          // and 429'ing within seconds of the merge() kickoff.
          serializeKey: `shopify:${this.marketplace_id}`,
        },
      );
      if (!resp.ok) return undefined;
      const data = resp.json<{ product?: { variants?: Array<{ barcode?: string | null }> } }>();
      const raw = data.product?.variants?.find((v) => v.barcode)?.barcode;
      if (!raw) return undefined;
      const trimmed = raw.trim();
      return /^\d{8,14}$/.test(trimmed) ? trimmed : undefined;
    } catch {
      return undefined;
    }
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#39;|&quot;|&lt;|&gt;/g, (m) =>
      ({ "&nbsp;": " ", "&amp;": "&", "&#39;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">" }[m] ?? m),
    )
    .replace(/\s+/g, " ")
    .trim();
}
