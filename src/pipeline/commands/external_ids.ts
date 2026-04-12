/**
 * External identifier mapping shared between detect_tier (fastPath lookup)
 * and persist (indexing). Adding a key here gives the pipeline both the
 * zero-LLM Tier-1 hit AND the automatic product_identifiers upgrade when
 * a later scan sees the same id.
 *
 * Tuple shape: [extra-key, identifier_type].
 *
 *  extra-key        — the property name the adapter drops into RawListing.extra
 *  identifier_type  — the canonical string stored in product_identifiers
 *
 * Cross-marketplace identifiers (UPC, ASIN, EPID, ISBN, MPN) bridge across
 * retailers. Per-store SKUs are stable WITHIN a marketplace over time — a
 * re-listed K&L auction gets a new marketplace_listing_id (missing Tier-2
 * cache), but the klwines_sku is unchanged, so Tier-1 still fires.
 */
export const EXTERNAL_ID_KEYS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  // Cross-marketplace universal identifiers.
  ["upc", "upc"],
  ["asin", "asin"],
  ["epid", "ebay_epid"],
  ["isbn", "isbn"],
  ["mpn", "mpn"],

  // Marketplace-native catalog ids.
  ["pc_product_id", "pricecharting"],
  ["discogs_id", "discogs"],
  ["tcgplayer_id", "tcgplayer"],
  ["mercari_id", "mercari"],

  // Per-store stable SKUs — good for reidentifying the same bottle/card when
  // the marketplace reuses the listing under a new marketplace_listing_id.
  ["klwines_sku", "klwines_sku"],
  ["bb_sku", "bb_sku"],
  ["seelbachs_sku", "seelbachs_sku"],
  ["shopsk_sku", "shopsk_sku"],
  ["woodencork_sku", "woodencork_sku"],
  ["caskcartel_sku", "caskcartel_sku"],
  ["whiskybusiness_sku", "whiskybusiness_sku"],
  ["flaviar_sku", "flaviar_sku"],
]);
