/**
 * processKnownProduct — Tier 1 fast path.
 *
 * The adapter gave us an external identifier that resolved to a known
 * product. Skip extract/classify entirely: upsert the listing, write a
 * listing_item link, record a price_point, evaluate, done.
 */

import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { products } from "@/db/schema";
import { taxonomyRepo } from "@/db/repos/TaxonomyRepo";
import type { ValidatedListing, Opportunity } from "../types";
import { persist } from "./persist";
import { writePricePoint } from "./write_price_point";
import {
  evaluateOpportunities,
  type OpportunityThresholds,
} from "./evaluate_opportunities";
import type { FieldValue } from "./validate_fields";

export interface ProcessKnownInput {
  readonly listing: ValidatedListing;
  readonly productId: string;
  readonly thresholds?: Partial<OpportunityThresholds>;
  readonly ollamaUrl?: string;
}

export interface ProcessKnownResult {
  readonly listingId: number;
  readonly productId: string;
  readonly opportunities: readonly Opportunity[];
  readonly tier: "external_id";
}

export async function processKnownProduct(
  input: ProcessKnownInput,
): Promise<ProcessKnownResult> {
  const product = await db.query.products.findFirst({
    where: eq(products.id, input.productId),
    columns: { id: true, taxonomyNodeId: true, title: true },
  });

  // Derive taxonomy node (fall back to root if product has none).
  let nodeId = product?.taxonomyNodeId ?? null;
  if (!nodeId) {
    const root = await taxonomyRepo.getRoot();
    nodeId = root.id;
  }
  const node = await taxonomyRepo.getNode(nodeId);
  const schema = await taxonomyRepo.getAccumulatedSchema(nodeId);
  if (!node) {
    throw new Error(`processKnownProduct: taxonomy node ${nodeId} missing`);
  }

  // Infer pricing-axis values from listing.extra (e.g. PriceCharting
  // `include: "loose only"` → condition=loose; "complete" → cib).
  const fields = inferPricingFields(input.listing);

  // Write the listing + link; don't create a new product.
  const persisted = await persist({
    listing: input.listing,
    product: {
      productId: input.productId,
      isNew: false,
      method: "external_id",
      title: product?.title ?? input.listing.title,
    },
    fields,
    nodeId,
    schemaVersion: await taxonomyRepo.getCurrentSchemaVersion(),
    ollamaUrl: input.ollamaUrl,
    confirmed: true,
  });

  // Record a price_point for this listing (dimensions derived from fields).
  await writePricePoint({
    productId: input.productId,
    source: input.listing.marketplaceId,
    priceUsd: input.listing.priceUsd,
    fields,
    schema,
  });

  // Evaluate against recent price_points — allow same source because the
  // fast path specifically wants us to compare against the product's canonical
  // catalog prices (which likely come from the same source, e.g. PriceCharting).
  const opportunities = await evaluateOpportunities({
    listingDbId: persisted.listingId,
    listingMarketplaceId: input.listing.marketplaceId,
    productId: input.productId,
    listingPrice: input.listing.priceUsd,
    shippingUsd: input.listing.shippingUsd,
    node,
    schema,
    fields,
    thresholds: input.thresholds,
    allowSameSource: true,
  });

  return Object.freeze({
    listingId: persisted.listingId,
    productId: input.productId,
    opportunities,
    tier: "external_id" as const,
  });
}

/**
 * Extract pricing-axis-like hints from the listing's extra blob. This is a
 * small, hardcoded mapping of common adapter hints — NOT a replacement for
 * the full extract phase. It just lets the fast path pick the right price
 * bucket when the adapter already told us which one.
 */
function inferPricingFields(
  listing: ValidatedListing,
): ReadonlyMap<string, FieldValue> {
  const out = new Map<string, FieldValue>();
  const extra = listing.extra ?? {};

  const include = typeof extra.include === "string" ? extra.include.toLowerCase() : "";
  if (include) {
    if (/only|disc only|cart only|cartridge only|loose/.test(include)) {
      out.set("condition", "loose");
    } else if (/sealed|new/.test(include)) {
      out.set("condition", "new_sealed");
    } else if (/complete|cib|in box|in-box/.test(include)) {
      out.set("condition", "cib");
    }
  }

  const explicit = typeof extra.condition === "string" ? extra.condition.trim() : "";
  if (explicit && !out.has("condition")) out.set("condition", explicit);

  return out;
}
