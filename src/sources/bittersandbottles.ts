/**
 * Bitters & Bottles — craft spirits marketplace at bittersandbottles.com.
 *
 * Shopify-backed, so the public `/products.json` endpoint is our API: no
 * Playwright, no auth, no Cloudflare. Paginates 250 products at a time
 * until an empty page. Collections (e.g. /collections/whiskey) also expose
 * /collections/:handle/products.json — we use that for discovery queries
 * so each stream targets one spirits category at a time, mirroring how
 * K&L splits into auctions/new_product/etc.
 */

import {
  IMarketplaceAdapter,
  RawListing,
  makeRawListing,
} from "./IMarketplaceAdapter";
import { cachedFetch } from "@/lib/cached_fetch";
import { log } from "@/lib/logger";

const BASE = "https://www.bittersandbottles.com";
const PAGE_SIZE = 250;
/** Shopify caps per-page at 250 and stops yielding after ~10 pages by default. */
const MAX_PAGES = 40;

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
  readonly published_at?: string;
  readonly created_at?: string;
  readonly updated_at?: string;
}
interface ProductsResp { readonly products?: ShopifyProduct[] }

/** Minimum product count for a collection to be worth scanning. Small
 *  collections are usually curated flights or bundles that duplicate the
 *  main spirits bucket. */
const MIN_COLLECTION_SIZE = 30;

/** Fallback when /collections.json is unreachable — Shopify's catch-all
 *  collection "spirits" holds most bottles. */
const FALLBACK_COLLECTIONS = Object.freeze([
  "spirits",
  "bitters",
  "liqueur",
  "mixers",
  "new-arrivals",
]);

let discoveryCache: { at: number; handles: string[] } | null = null;
const DISCOVERY_TTL_MS = 6 * 60 * 60_000;

async function fetchCollectionHandles(): Promise<string[]> {
  if (discoveryCache && Date.now() - discoveryCache.at < DISCOVERY_TTL_MS) {
    return discoveryCache.handles;
  }
  try {
    const resp = await cachedFetch(
      `${BASE}/collections.json?limit=250`,
      { method: "GET" },
      { ttlMs: DISCOVERY_TTL_MS, cacheTag: "bb:collections" },
    );
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = resp.json<{ collections?: Array<{ handle: string; products_count: number }> }>();
    const handles = (data.collections ?? [])
      .filter((c) => c.products_count >= MIN_COLLECTION_SIZE)
      .sort((a, b) => b.products_count - a.products_count)
      .map((c) => c.handle);
    log("bittersandbottles", `discovered ${handles.length} collections (≥${MIN_COLLECTION_SIZE} products)`);
    discoveryCache = { at: Date.now(), handles };
    return handles;
  } catch (err) {
    log("bittersandbottles", `collections.json failed (${(err as Error).message}) — using fallback`);
    return [...FALLBACK_COLLECTIONS];
  }
}

export class BittersAndBottlesAdapter implements IMarketplaceAdapter {
  readonly marketplace_id = "bittersandbottles";
  /** Lazily fetched on first discoveryQueries() call via fetchCollectionHandles. */
  private cachedQueries: string[] | null = null;

  isAvailable(): boolean {
    return true;
  }

  discoveryQueries(): string[] {
    // Sync interface — warm the cache eagerly via async probe on a separate
    // tick and return whatever we have. First call returns the fallback;
    // subsequent calls return the live list.
    if (!this.cachedQueries) {
      this.cachedQueries = [...FALLBACK_COLLECTIONS];
      fetchCollectionHandles().then((handles) => {
        if (handles.length) this.cachedQueries = handles;
      });
    }
    return [...this.cachedQueries];
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

    // "all" — full catalog; anything else — a collection handle.
    const isCollection = query && query !== "all";
    const pathBase = isCollection
      ? `${BASE}/collections/${encodeURIComponent(query)}/products.json`
      : `${BASE}/products.json`;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${pathBase}?limit=${PAGE_SIZE}&page=${page}`;
      const resp = await cachedFetch(
        url,
        { method: "GET" },
        { ttlMs: 6 * 60 * 60_000, cacheTag: `bb:${query}` },
      );
      if (!resp.ok) {
        log(
          "bittersandbottles",
          `${query} page ${page} → HTTP ${resp.status}, stopping`,
        );
        break;
      }
      const data = resp.json<ProductsResp>();
      const products = data.products ?? [];
      if (products.length === 0) {
        log(
          "bittersandbottles",
          `${query}: empty page ${page}, stopping (total emitted=${emitted})`,
        );
        break;
      }
      log(
        "bittersandbottles",
        `${query} page ${page} → ${products.length} products`,
      );
      for (const p of products) {
        const listing = toListing(p);
        if (!listing) continue;
        if (options.max_price != null && listing.price_usd > options.max_price) continue;
        // Fetch the per-product JSON to grab barcode (UPC) — the collection
        // API strips it. Cached 7 days; first scan pays the cost once per
        // bottle, repeat scans are free.
        const upc = await fetchUpc(p.handle);
        if (upc) {
          listing.extra = { ...listing.extra, upc };
        }
        yield listing;
        emitted++;
        if (emitted >= limit) return;
      }
      if (products.length < PAGE_SIZE) break; // last page
    }
  }
}

async function fetchUpc(handle: string): Promise<string | undefined> {
  try {
    const resp = await cachedFetch(
      `${BASE}/products/${encodeURIComponent(handle)}.json`,
      { method: "GET" },
      { ttlMs: 7 * 24 * 60 * 60_000, cacheTag: "bb:upc" },
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

function toListing(p: ShopifyProduct): RawListing | null {
  // Cheapest available variant sets the listing price; Shopify represents
  // out-of-stock SKUs as variants with available=false but price still set.
  const variants = p.variants ?? [];
  const available = variants.filter((v) => v.available !== false);
  const pick = available[0] ?? variants[0];
  if (!pick?.price) return null;
  const price = parseFloat(pick.price);
  if (!isFinite(price) || price <= 0) return null;

  const desc = (p.body_html ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&#39;|&quot;|&lt;|&gt;/g, (m) =>
      ({ "&nbsp;": " ", "&amp;": "&", "&#39;": "'", "&quot;": '"', "&lt;": "<", "&gt;": ">" }[m] ?? m),
    )
    .replace(/\s+/g, " ")
    .trim();

  return makeRawListing({
    marketplace_id: "bittersandbottles",
    listing_id: String(p.id),
    title: p.title,
    price_usd: price,
    shipping_usd: 0,
    url: `${BASE}/products/${p.handle}`,
    description: desc || undefined,
    image_url: p.images?.[0]?.src,
    seller: p.vendor,
    category_raw: p.product_type,
    extra: {
      handle: p.handle,
      tags: p.tags ?? [],
      bb_product_id: p.id,
      bb_sku: pick.sku,
      available: pick.available !== false,
      // UPC is added by the streaming loop after a per-product fetch — the
      // collection API strips barcode fields.
    } as Record<string, unknown>,
  });
}
