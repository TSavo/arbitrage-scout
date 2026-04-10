/**
 * Base marketplace interface. Every marketplace adapter implements this.
 * Ported from base_marketplace.py.
 */

export interface RawListing {
  /** Identifies which marketplace this came from, e.g. "ebay", "shopgoodwill" */
  marketplace_id: string;
  /** The marketplace's own ID for this listing */
  listing_id: string;
  /** Raw listing title as returned by the marketplace */
  title: string;
  /** Buy-it-now or current bid price in USD */
  price_usd: number;
  /** Shipping cost in USD, 0 if free or unknown */
  shipping_usd: number;
  /** Canonical URL to the listing page */
  url?: string;
  /** Full item description text (may be HTML-stripped) */
  description?: string;
  /** Marketplace's own condition string, e.g. "Pre-Owned", "Like New" */
  condition_raw?: string;
  /** Marketplace's own category label */
  category_raw?: string;
  /** Primary image URL */
  image_url?: string;
  /** Seller username or store name */
  seller?: string;
  /** Current number of bids (0 for fixed-price) */
  num_bids: number;
  /** Number of items in the lot (>1 means a lot listing) */
  item_count: number;
  /** Auction end time as ISO string, undefined for fixed-price */
  end_time?: string;
  /** Adapter-specific extra fields that don't fit the schema */
  extra: Record<string, unknown>;
}

export function makeRawListing(
  fields: Pick<RawListing, "marketplace_id" | "listing_id" | "title" | "price_usd"> &
    Partial<RawListing>,
): RawListing {
  return {
    shipping_usd: 0,
    num_bids: 0,
    item_count: 1,
    extra: {},
    ...fields,
  };
}

export interface IMarketplaceAdapter {
  /** Stable string identifier for this marketplace, e.g. "ebay" */
  readonly marketplace_id: string;

  /**
   * Return broad queries to discover what this marketplace has.
   * These are category-level searches: "video games", "nintendo",
   * "pokemon cards", etc. The pipeline searches each one and then
   * identifies individual products via LLM.
   */
  discoveryQueries(): string[];

  /**
   * Search this marketplace and return raw listings.
   *
   * @param query   Search keywords
   * @param options.max_price   Upper price bound in USD (inclusive)
   * @param options.limit       Max results to return
   */
  search(
    query: string,
    options?: { max_price?: number; limit?: number },
  ): Promise<RawListing[]>;

  /** Can we use this marketplace right now? (auth OK, not rate-limited) */
  isAvailable(): boolean;
}
