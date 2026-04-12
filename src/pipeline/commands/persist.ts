/**
 * persist — write listing, product (if new), and listing_item rows. Embed
 * the listing for future similarity searches.
 *
 * No raw SQL — all Drizzle.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  listings,
  listingItems,
  products,
  productIdentifiers,
} from "@/db/schema";
import { embeddingRepo } from "@/db/repos/EmbeddingRepo";
import type { ValidatedListing } from "../types";
import type { FieldValue } from "./validate_fields";
import type { IdentityResolution } from "./resolve_identity";

export interface PersistResult {
  readonly listingId: number;
  readonly productId: string;
  readonly listingItemId: number;
  readonly isNewProduct: boolean;
  readonly isNewListing: boolean;
}

export interface PersistInput {
  readonly listing: ValidatedListing;
  readonly product: IdentityResolution;
  readonly fields: ReadonlyMap<string, FieldValue>;
  readonly nodeId: number;
  readonly schemaVersion: number;
  readonly ollamaUrl?: string;
  /** When true, the listing→product link is recorded as confirmed. */
  readonly confirmed?: boolean;
}

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
  ["klwines_sku", "klwines_sku"],
]);

export async function persist(input: PersistInput): Promise<PersistResult> {
  const now = new Date().toISOString();
  const confirmed = input.confirmed ?? true;

  // ── 1. Upsert listing row ─────────────────────────────────────────
  const existingListing = await db.query.listings.findFirst({
    where: and(
      eq(listings.marketplaceId, input.listing.marketplaceId),
      eq(listings.marketplaceListingId, input.listing.listingId),
    ),
    columns: { id: true },
  });

  let listingDbId: number;
  let isNewListing = false;
  if (existingListing) {
    await db
      .update(listings)
      .set({
        title: input.listing.title,
        url: input.listing.url || null,
        description: input.listing.description ?? null,
        priceUsd: input.listing.priceUsd,
        shippingUsd: input.listing.shippingUsd,
        seller: input.listing.seller ?? null,
        lastSeenAt: now,
        isActive: true,
      })
      .where(eq(listings.id, existingListing.id));
    listingDbId = existingListing.id;
  } else {
    const inserted = await db
      .insert(listings)
      .values({
        marketplaceId: input.listing.marketplaceId,
        marketplaceListingId: input.listing.listingId,
        url: input.listing.url || null,
        title: input.listing.title,
        description: input.listing.description ?? null,
        priceUsd: input.listing.priceUsd,
        shippingUsd: input.listing.shippingUsd,
        seller: input.listing.seller ?? null,
        isLot: (input.listing.itemCount ?? 1) > 1,
        firstSeenAt: now,
        lastSeenAt: now,
        isActive: true,
      })
      .returning({ id: listings.id });
    listingDbId = inserted[0].id;
    isNewListing = true;
  }

  // ── 2. Upsert product row ─────────────────────────────────────────
  let productId = input.product.productId;
  let isNewProduct = input.product.isNew;

  if (isNewProduct) {
    const metadata: Record<string, unknown> = {};
    for (const [k, v] of input.fields) metadata[k] = v;

    await db.insert(products).values({
      id: productId,
      taxonomyNodeId: input.nodeId,
      extractedSchemaVersion: input.schemaVersion > 0 ? input.schemaVersion : null,
      title: input.product.title,
      metadata,
      salesVolume: 0,
      createdAt: now,
      updatedAt: now,
    });

    // Record any external identifiers present in extra.
    const extra = input.listing.extra ?? {};
    for (const [key, type] of EXTERNAL_ID_KEYS) {
      const raw = extra[key];
      if (raw === undefined || raw === null) continue;
      const value = typeof raw === "string" ? raw.trim() : String(raw).trim();
      if (!value) continue;
      await db
        .insert(productIdentifiers)
        .values({
          productId,
          identifierType: type,
          identifierValue: value,
        })
        .onConflictDoNothing();
    }
  } else {
    // Update schema watermark if schema has moved forward.
    if (input.schemaVersion > 0) {
      await db
        .update(products)
        .set({
          extractedSchemaVersion: input.schemaVersion,
          taxonomyNodeId: input.nodeId,
          updatedAt: now,
        })
        .where(eq(products.id, productId));
    }
    // Check for the rare case the product truly did not exist (defensive).
    const exists = await db.query.products.findFirst({
      where: eq(products.id, productId),
      columns: { id: true },
    });
    if (!exists) {
      await db.insert(products).values({
        id: productId,
        taxonomyNodeId: input.nodeId,
        extractedSchemaVersion:
          input.schemaVersion > 0 ? input.schemaVersion : null,
        title: input.product.title,
        metadata: metadataFromFields(input.fields),
        salesVolume: 0,
        createdAt: now,
        updatedAt: now,
      });
      isNewProduct = true;
    }
  }

  // ── 3. Upsert listing_items link ──────────────────────────────────
  const condition = conditionFromFields(input.fields);
  const conditionDetails: Record<string, unknown> = {};
  for (const [k, v] of input.fields) conditionDetails[k] = v;

  const existingItem = await db.query.listingItems.findFirst({
    where: and(
      eq(listingItems.listingId, listingDbId),
      eq(listingItems.productId, productId),
    ),
    columns: { id: true },
  });

  let listingItemId: number;
  if (existingItem) {
    await db
      .update(listingItems)
      .set({
        condition,
        conditionDetails,
        confirmed,
        confidence: 1,
      })
      .where(eq(listingItems.id, existingItem.id));
    listingItemId = existingItem.id;
  } else {
    const inserted = await db
      .insert(listingItems)
      .values({
        listingId: listingDbId,
        productId,
        quantity: input.listing.itemCount ?? 1,
        condition,
        conditionDetails,
        confidence: 1,
        confirmed,
        rawExtraction: conditionDetails,
      })
      .returning({ id: listingItems.id });
    listingItemId = inserted[0].id;
  }

  // ── 4. Embed the listing text ─────────────────────────────────────
  if (isNewListing) {
    const text =
      `${input.listing.title} ${input.listing.description ?? ""}`.trim();
    try {
      await embeddingRepo.getOrCompute(
        "listing",
        listingDbId.toString(),
        text,
        input.ollamaUrl,
      );
    } catch {
      // Embedding is best-effort; will retry in a background job.
    }
  }
  // Always (attempt to) embed the product for future similarity lookups.
  if (isNewProduct) {
    try {
      await embeddingRepo.getOrCompute(
        "product",
        productId,
        input.product.title,
        input.ollamaUrl,
      );
    } catch {
      // Best-effort.
    }
  }

  return Object.freeze({
    listingId: listingDbId,
    productId,
    listingItemId,
    isNewProduct,
    isNewListing,
  });
}

function metadataFromFields(
  fields: ReadonlyMap<string, FieldValue>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of fields) out[k] = v;
  return out;
}

function conditionFromFields(
  fields: ReadonlyMap<string, FieldValue>,
): string {
  const v = fields.get("condition");
  return typeof v === "string" ? v : "";
}
