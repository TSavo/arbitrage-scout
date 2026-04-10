/**
 * Schema-driven prompt builders for the three-stage identification pipeline.
 *
 * Stage 1 (extraction) and Stage 3 (confirmation) prompts are built here.
 * The product type schema drives what the LLM extracts — adding a new type
 * in the DB automatically changes the prompt without code changes.
 */

import type { ProductType } from "../db/repos/ProductTypeRepo";

// ── Types used by the prompt builders ────────────────────────────────

/** Raw data from a marketplace adapter, before identification. */
export interface RawListing {
  marketplaceId: string;
  title: string;
  description?: string | null;
  conditionRaw?: string | null;
  categoryRaw?: string | null;
  priceUsd: number;
  shippingUsd?: number | null;
  itemCount?: number | null;
  numBids?: number | null;
  endTime?: string | null;
  seller?: string | null;
  imageUrl?: string | null;
  extra?: Record<string, unknown> | null;
}

export interface CatalogCandidate {
  productId: string;
  title: string;
  platform: string;
  loosePrice: number;
  score: number;
}

// ── Stage helpers ─────────────────────────────────────────────────────

/**
 * Build the product-type section of the extraction prompt from DB records.
 * Adding a type with new condition/metadata fields is automatically reflected here.
 */
export function buildSchemaPrompt(productTypes: ProductType[]): string {
  if (productTypes.length === 0) return "";

  return productTypes
    .map((pt) => {
      const conditions = pt.conditionSchema ?? [];
      const metadata = pt.metadataSchema ?? [];
      const lines = [`- **${pt.name}** (type: \`${pt.id}\`)`];
      if (conditions.length) lines.push(`  Conditions: ${conditions.join(", ")}`);
      if (metadata.length) lines.push(`  Metadata to extract: ${metadata.join(", ")}`);
      return lines.join("\n");
    })
    .join("\n");
}

/**
 * Build a rich context block from everything a marketplace adapter provided.
 * Every non-null field is included — more data = better extraction.
 */
export function buildListingContext(listing: RawListing): string {
  const lines: string[] = [];
  lines.push(`Marketplace: ${listing.marketplaceId}`);
  lines.push(`Title: "${listing.title}"`);
  if (listing.description) lines.push(`Description: "${listing.description}"`);
  if (listing.conditionRaw) lines.push(`Marketplace condition: ${listing.conditionRaw}`);
  if (listing.categoryRaw) lines.push(`Marketplace category: ${listing.categoryRaw}`);
  if (listing.itemCount && listing.itemCount > 1) {
    lines.push(`Listed as lot of ${listing.itemCount} items`);
  }
  const priceStr = `$${listing.priceUsd.toFixed(2)}`;
  const shippingStr =
    listing.shippingUsd ? ` + $${listing.shippingUsd.toFixed(2)} shipping` : "";
  lines.push(`Price: ${priceStr}${shippingStr}`);
  if (listing.numBids) {
    lines.push(
      `Current bids: ${listing.numBids} (auction — price will likely increase)`,
    );
  }
  if (listing.endTime) lines.push(`Auction ends: ${listing.endTime}`);
  if (listing.seller) lines.push(`Seller: ${listing.seller}`);
  if (listing.imageUrl) lines.push(`Image: ${listing.imageUrl}`);
  if (listing.extra) {
    for (const [k, v] of Object.entries(listing.extra)) {
      if (v !== null && v !== undefined && v !== "" && k !== "pc_product_id") {
        lines.push(`${k}: ${v}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Stage 1 extraction prompt. Asks the LLM to decompose the listing into
 * structured product records, one per named item.
 */
export function buildExtractionPrompt(
  listingContext: string,
  schemaPrompt: string,
): string {
  return (
    `## Marketplace listing\n\n${listingContext}\n\n` +
    "## Your task\n\n" +
    "We are building an arbitrage tool that finds underpriced collectibles " +
    "across marketplaces (eBay, ShopGoodwill, PriceCharting). We need to " +
    "identify exactly what products are in this listing so we can look up " +
    "their market value in our catalog of 300,000+ products.\n\n" +
    "If this is a LOT containing multiple items, extract EACH named item " +
    "separately. The system will price each one individually and compare " +
    "the total value against the lot price. This is how we find underpriced " +
    "lots — a $50 lot containing $200 worth of games is a deal.\n\n" +
    "## Product types we track\n\n" +
    `${schemaPrompt}\n\n` +
    "## Rules\n\n" +
    "- Identify EVERY individual product in the listing\n" +
    "- Use the FULL canonical product name (expand SM64 → Super Mario 64, " +
    "CIB → Complete in Box, NM → Near Mint)\n" +
    "- Pick the correct product_type from the list above\n" +
    "- Pick the condition from that type's valid conditions\n" +
    "- Fill in ALL metadata fields defined for that product type — this is " +
    "critical for accurate pricing (a 1st edition holo is worth 10x unlimited)\n" +
    "- If the listing is NOT a product we track (furniture, clothing, Wi-Fi " +
    "equipment, plush toys, board games), return empty items\n" +
    "- If it's a random/mystery lot with no named items, return empty\n" +
    "- If the title mentions 'untested', 'for parts', 'as-is', note that " +
    "in the metadata — it affects value significantly\n\n" +
    "## Response format\n\n" +
    '{"items": [{"name": "canonical product name", "product_type": "type_id", ' +
    '"condition": "from valid conditions", "platform": "console or set name", ' +
    '"metadata": {fill in all metadata fields for this type}, ' +
    '"quantity": 1}]}\n'
  );
}

export const EXTRACTION_SYSTEM =
  "You are a product identification specialist for a collectibles " +
  "arbitrage system. Your job is to turn unstructured marketplace " +
  "listings into structured product data that can be matched against " +
  "a price catalog of 300,000+ items. " +
  "Precision matters: the downstream system uses fuzzy matching, so " +
  "the closer your extraction is to the canonical name (e.g. 'Super " +
  "Mario 64' not 'SM64 N64 Cart'), the better the match. " +
  "Completeness matters: every metadata field you fill in helps the " +
  "system pick the right price point (a graded PSA 10 Charizard is " +
  "worth 100x a loose played copy). " +
  "Reply with JSON only.";

/**
 * Stage 3 confirmation prompt.
 *
 * extracted: items from Stage 1 (parallel arrays, same index)
 * candidateGroups: top catalog candidates per item index
 * listingPrice: total listing price in USD
 * marketplace: marketplace ID string
 * conditionHint: comma-joined valid conditions for this product type
 */
export function buildConfirmationPrompt(
  extracted: Array<{
    name: string;
    productType: string;
    platform: string;
    condition: string;
    metadata: Record<string, unknown>;
  }>,
  candidateGroups: Map<number, CatalogCandidate[]>,
  listingPrice: number,
  marketplace: string,
  conditionHint = "loose, cib, new_sealed, graded",
): string {
  const lines: string[] = [];

  for (let idx = 0; idx < extracted.length; idx++) {
    const item = extracted[idx];
    const cands = candidateGroups.get(idx) ?? [];

    const metaParts = Object.entries(item.metadata)
      .filter(([, v]) => v !== null && v !== undefined && v !== "")
      .map(([k, v]) => `${k}=${v}`);
    const metaStr = metaParts.length ? ` | ${metaParts.join(", ")}` : "";

    lines.push(
      `Item ${idx + 1}: "${item.name}" ` +
        `(type: ${item.productType}, platform: ${item.platform}, ` +
        `condition: ${item.condition}${metaStr})`,
    );

    if (cands.length === 0) {
      lines.push("  No catalog matches found → null");
      continue;
    }

    cands.forEach((c, j) => {
      const letter = String.fromCharCode(65 + j);
      const pct = `${(c.score * 100).toFixed(0)}%`;
      lines.push(
        `  ${letter}) ${c.title} (${c.platform}) — $${c.loosePrice.toFixed(2)} loose [${pct} match]`,
      );
    });
    lines.push(`  ${String.fromCharCode(65 + cands.length)}) None of these`);
  }

  const perItemLine =
    extracted.length > 1
      ? `Per-item cost: $${(listingPrice / extracted.length).toFixed(2)}\n`
      : "";

  return (
    "## Context\n\n" +
    "You are the final gate in our arbitrage identification pipeline.\n" +
    "Stage 1 extracted product data from a marketplace listing.\n" +
    "Stage 2 found candidate matches in our 300K product catalog.\n" +
    "Your job: confirm or reject each match.\n\n" +
    `Listing price: $${listingPrice.toFixed(2)} on ${marketplace}\n` +
    `Item count: ${extracted.length} items extracted\n` +
    perItemLine +
    "\n" +
    "## Extracted items and catalog candidates\n\n" +
    lines.join("\n") +
    "\n\n" +
    "## Instructions\n\n" +
    "- Pick the catalog product that BEST matches the extracted item\n" +
    "- Reject (null) if no candidate is the right product\n" +
    "- Reject if the listing is a reproduction, fake, or unrelated item\n" +
    "- Confirm the condition based on the listing context\n" +
    `  Valid conditions: ${conditionHint}\n\n` +
    "## Response\n\n" +
    '{"matches": [{"item": 1, "choice": "A", "condition": "condition_value"}, ...]}\n' +
    "Use null for choice if no match."
  );
}

export const CONFIRMATION_SYSTEM =
  "You are the quality gate in a collectibles arbitrage system. " +
  "We buy underpriced items on one marketplace and resell at market " +
  "value on another. A false positive here means we buy something " +
  "worthless thinking it's valuable — that costs real money. A false " +
  "negative means we miss a deal — that's fine, there will be more. " +
  "When in doubt, reject. Only confirm matches you're confident about. " +
  "Reply with JSON only.";
