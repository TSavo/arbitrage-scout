/**
 * detectTier — three-tier speedrun routing for the taxonomy pipeline.
 *
 * Tier 1 (external_id): the adapter put a known canonical identifier in
 *   listing.extra (pc_product_id, discogs_id, upc, asin, ...). Look it up in
 *   product_identifiers. Zero-LLM fast path.
 *
 * Tier 2 (cached): we've seen this marketplace_listing_id before and it has
 *   confirmed listing_items → reuse the product(s) that were resolved previously.
 *   Zero-LLM re-evaluate path.
 *
 * Tier 3 (full_walk): novel listing → extract + classify walk.
 *
 * No raw SQL anywhere — Drizzle query builder only.
 */

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import {
  listings,
  listingItems,
  productIdentifiers,
} from "@/db/schema";
import type { RawListing } from "../types";

/** Keys in RawListing.extra that map to canonical external identifier types. */
const EXTERNAL_ID_KEYS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["pc_product_id", "pricecharting"],
  ["discogs_id", "discogs"],
  ["tcgplayer_id", "tcgplayer"],
  ["mercari_id", "mercari"],
  ["upc", "upc"],
  ["asin", "asin"],
  ["epid", "ebay_epid"],
  ["isbn", "isbn"],
  ["mpn", "mpn"],
]);

export type TierDetection =
  | {
      readonly kind: "external_id";
      readonly productId: string;
      readonly identifierType: string;
      readonly identifierValue: string;
    }
  | {
      readonly kind: "cached";
      readonly existingListingId: number;
      readonly productIds: readonly string[];
    }
  | { readonly kind: "full_walk" };

export async function detectTier(listing: RawListing): Promise<TierDetection> {
  // Tier 1 — external identifier lookup.
  const extra = listing.extra ?? {};
  for (const [key, identifierType] of EXTERNAL_ID_KEYS) {
    const raw = extra[key];
    if (raw === undefined || raw === null) continue;
    const value = typeof raw === "string" ? raw.trim() : String(raw).trim();
    if (!value) continue;

    // First try the normalized identifier_type
    const hit = await db.query.productIdentifiers.findFirst({
      where: and(
        eq(productIdentifiers.identifierType, identifierType),
        eq(productIdentifiers.identifierValue, value),
      ),
      columns: { productId: true },
    });
    if (hit) {
      return Object.freeze({
        kind: "external_id" as const,
        productId: hit.productId,
        identifierType,
        identifierValue: value,
      });
    }

    // Also try the raw key as the identifier_type (adapters that inserted
    // identifiers under the raw name like "pc_product_id").
    const hitRaw = await db.query.productIdentifiers.findFirst({
      where: and(
        eq(productIdentifiers.identifierType, key),
        eq(productIdentifiers.identifierValue, value),
      ),
      columns: { productId: true },
    });
    if (hitRaw) {
      return Object.freeze({
        kind: "external_id" as const,
        productId: hitRaw.productId,
        identifierType: key,
        identifierValue: value,
      });
    }

    // Fallback: if the adapter used pc_product_id and the product id IS the
    // pc value (legacy PriceCharting seed), look up the product row directly.
    if (key === "pc_product_id") {
      const { products } = await import("@/db/schema");
      const prodRow = await db.query.products.findFirst({
        where: eq(products.id, value),
        columns: { id: true },
      });
      if (prodRow) {
        return Object.freeze({
          kind: "external_id" as const,
          productId: prodRow.id,
          identifierType: "pricecharting",
          identifierValue: value,
        });
      }
    }
  }

  // Tier 2 — previously seen listing?
  const existing = await db.query.listings.findFirst({
    where: and(
      eq(listings.marketplaceId, listing.marketplaceId),
      eq(listings.marketplaceListingId, listing.listingId),
    ),
    columns: { id: true },
  });
  if (existing) {
    const confirmedItems = await db
      .select({ productId: listingItems.productId })
      .from(listingItems)
      .where(
        and(
          eq(listingItems.listingId, existing.id),
          eq(listingItems.confirmed, true),
        ),
      );
    if (confirmedItems.length > 0) {
      return Object.freeze({
        kind: "cached" as const,
        existingListingId: existing.id,
        productIds: Object.freeze(confirmedItems.map((r) => r.productId)),
      });
    }
  }

  // keep inArray reference bound (used by downstream callers, removes TS unused)
  void inArray;

  // Tier 3 — full walk.
  return Object.freeze({ kind: "full_walk" as const });
}
