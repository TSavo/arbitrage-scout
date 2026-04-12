/**
 * processCachedListing — Tier 2 re-evaluate path.
 *
 * We've seen this marketplace_listing_id before and it already has confirmed
 * listing_items. The price may have changed — update the listing and re-run
 * evaluate against the existing product(s). No LLM, no extract, no classify.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { listings, listingItems, products } from "@/db/schema";
import { taxonomyRepo } from "@/db/repos/TaxonomyRepo";
import type { ValidatedListing, Opportunity } from "../types";
import {
  evaluateOpportunities,
  type OpportunityThresholds,
} from "./evaluate_opportunities";
import type { FieldValue } from "./validate_fields";

export interface ProcessCachedInput {
  readonly listing: ValidatedListing;
  readonly existingListingId: number;
  readonly productIds: readonly string[];
  readonly thresholds?: Partial<OpportunityThresholds>;
}

export interface ProcessCachedResult {
  readonly listingId: number;
  readonly opportunities: readonly Opportunity[];
  readonly tier: "cached";
}

export async function processCachedListing(
  input: ProcessCachedInput,
): Promise<ProcessCachedResult> {
  const now = new Date().toISOString();

  // Update the listing's last-seen + price (price may have changed).
  await db
    .update(listings)
    .set({
      priceUsd: input.listing.priceUsd,
      shippingUsd: input.listing.shippingUsd,
      lastSeenAt: now,
      isActive: true,
    })
    .where(eq(listings.id, input.existingListingId));

  const allOpps: Opportunity[] = [];

  for (const productId of input.productIds) {
    // Resolve node + schema for this product.
    const prod = await db.query.products.findFirst({
      where: eq(products.id, productId),
      columns: { id: true, taxonomyNodeId: true, title: true },
    });
    if (!prod) continue;

    let nodeId = prod.taxonomyNodeId ?? null;
    if (!nodeId) {
      const root = await taxonomyRepo.getRoot();
      nodeId = root.id;
    }
    const node = await taxonomyRepo.getNode(nodeId);
    const schema = await taxonomyRepo.getAccumulatedSchema(nodeId);
    if (!node) continue;

    // Load the existing listing_item to recover previously-stored condition
    // details (pricing-axis values we already validated on first pass).
    const item = await db.query.listingItems.findFirst({
      where: and(
        eq(listingItems.listingId, input.existingListingId),
        eq(listingItems.productId, productId),
      ),
      columns: { condition: true, conditionDetails: true },
    });

    const fields = fieldsFromCached(
      item?.condition,
      item?.conditionDetails,
    );

    const opps = await evaluateOpportunities({
      listingDbId: input.existingListingId,
      listingMarketplaceId: input.listing.marketplaceId,
      productId,
      listingPrice: input.listing.priceUsd,
      shippingUsd: input.listing.shippingUsd,
      node,
      schema,
      fields,
      thresholds: input.thresholds,
      allowSameSource: true,
    });
    for (const o of opps) allOpps.push(o);
  }

  return Object.freeze({
    listingId: input.existingListingId,
    opportunities: Object.freeze(allOpps),
    tier: "cached" as const,
  });
}

function fieldsFromCached(
  condition: string | undefined,
  details: unknown,
): ReadonlyMap<string, FieldValue> {
  const out = new Map<string, FieldValue>();
  if (details && typeof details === "object" && !Array.isArray(details)) {
    for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        out.set(k, v);
      }
    }
  }
  if (!out.has("condition") && condition) out.set("condition", condition);
  return out;
}
