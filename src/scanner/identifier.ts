/**
 * Three-stage listing identification.
 *
 * Stage 1 (extract): LLM reads the listing title, extracts everything —
 *   item names, conditions, platforms, variants, quantities, lot detection.
 * Stage 2 (match): For each extracted item, fuzzy search the 300K product
 *   catalog. Return top candidates with prices.
 * Stage 3 (confirm): One LLM call with all candidates. Multiple choice —
 *   pick the right product or reject. This is the gate.
 */

import { eq, desc, and, gt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { products, productTypes, pricePoints } from "../db/schema";
import type { LlmClient } from "./helpers";
import type { RawListing } from "../sources/IMarketplaceAdapter";

export type Db = BetterSQLite3Database<typeof schema>;

// ── Data types ────────────────────────────────────────────────────────

/** Raw item extracted from a listing title by the LLM. */
export interface ExtractedItem {
  name: string;
  productType: string;
  condition: string;
  platform: string;
  metadata: Record<string, unknown>;
  quantity: number;
}

/** A potential catalog match for an extracted item. */
export interface CatalogCandidate {
  productId: string;
  title: string;
  platform: string;
  loosePrice: number;
  score: number;
}

/** Final confirmed product match after LLM gate. */
export interface ConfirmedMatch {
  productId: string;
  title: string;
  platform: string;
  condition: string;
  marketPrice: number;
  confidence: number;
  details: Record<string, unknown>;
}

// ── Stage 1: Extract ──────────────────────────────────────────────────

/**
 * Build the extraction schema from product_types in the DB.
 *
 * This is the key insight: the DB schema defines what the LLM extracts.
 * Adding a new product type with new metadata fields automatically
 * changes the LLM prompt — no code changes needed.
 */
function buildSchemaPrompt(db: Db): string {
  const types = db.select().from(productTypes).all();
  if (!types.length) return "";

  const lines: string[] = [];
  for (const pt of types) {
    const conditions = pt.conditionSchema ?? [];
    const metadata = pt.metadataSchema ?? [];
    lines.push(`- **${pt.name}** (type: \`${pt.id}\`)`);
    if (conditions.length) lines.push(`  Conditions: ${conditions.join(", ")}`);
    if (metadata.length) lines.push(`  Metadata to extract: ${metadata.join(", ")}`);
  }
  return lines.join("\n");
}

/**
 * Build a rich context block from everything the adapter gave us.
 *
 * Every field the adapter provided gets included — nothing dropped.
 */
function buildListingContext(listing: RawListing): string {
  const lines: string[] = [];
  lines.push(`Marketplace: ${listing.marketplace_id}`);
  lines.push(`Title: "${listing.title}"`);
  if (listing.description) lines.push(`Description: "${listing.description}"`);
  if (listing.condition_raw) lines.push(`Marketplace condition: ${listing.condition_raw}`);
  if (listing.category_raw) lines.push(`Marketplace category: ${listing.category_raw}`);
  if (listing.item_count && listing.item_count > 1)
    lines.push(`Listed as lot of ${listing.item_count} items`);
  lines.push(
    `Price: $${listing.price_usd.toFixed(2)}` +
    (listing.shipping_usd ? ` + $${listing.shipping_usd.toFixed(2)} shipping` : ""),
  );
  if (listing.num_bids)
    lines.push(`Current bids: ${listing.num_bids} (auction — price will likely increase)`);
  if (listing.end_time) lines.push(`Auction ends: ${listing.end_time}`);
  if (listing.seller) lines.push(`Seller: ${listing.seller}`);
  if (listing.image_url) lines.push(`Image: ${listing.image_url}`);
  // Include everything from extra dict
  if (listing.extra) {
    for (const [k, v] of Object.entries(listing.extra)) {
      if (v && k !== "pc_product_id") {
        lines.push(`${k}: ${v}`);
      }
    }
  }
  return lines.join("\n");
}

/**
 * Stage 1: Extract structured product data from a listing.
 *
 * Takes the full RawListing — title, description, condition, category,
 * everything the adapter could give us. The more data, the better the
 * extraction.
 *
 * The prompt is built dynamically from the product_types table.
 * Handles lot decomposition — extracts each named item separately.
 */
export async function extractItems(
  listing: RawListing | string,
  llm: LlmClient | null,
  db: Db,
): Promise<ExtractedItem[]> {
  if (!llm) return [];

  const schemaPrompt = buildSchemaPrompt(db);
  const listingContext =
    typeof listing === "string"
      ? `Title: "${listing}"`
      : buildListingContext(listing);

  try {
    const result = await llm.generateJson(
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
      '"quantity": 1}]}\n',
      {
        system:
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
          "Reply with JSON only.",
      },
    );

    if (!result || typeof result !== "object" || Array.isArray(result)) return [];
    const items = (result as Record<string, unknown>)["items"];
    if (!Array.isArray(items)) return [];

    return items
      .filter(
        (i): i is Record<string, unknown> =>
          i !== null &&
          typeof i === "object" &&
          !Array.isArray(i) &&
          typeof (i as Record<string, unknown>)["name"] === "string" &&
          ((i as Record<string, unknown>)["name"] as string).length > 1,
      )
      .map((i) => ({
        name: i["name"] as string,
        productType: (i["product_type"] as string) ?? "",
        condition: (i["condition"] as string) ?? "loose",
        platform: (i["platform"] as string) ?? "",
        metadata: (i["metadata"] as Record<string, unknown>) ?? {},
        quantity: typeof i["quantity"] === "number" ? (i["quantity"] as number) : 1,
      }));
  } catch {
    return [];
  }
}

// ── Stage 2: Match candidates ─────────────────────────────────────────

/**
 * Simple difflib-style sequence match ratio.
 * Returns 0–1 where 1 = identical strings.
 */
function sequenceRatio(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  if (longer.length === 0) return 1;
  let matches = 0;
  const used = new Array<boolean>(longer.length).fill(false);
  for (const ch of shorter) {
    const idx = longer.indexOf(ch);
    if (idx !== -1 && !used[idx]) {
      matches++;
      used[idx] = true;
    }
  }
  return (2 * matches) / (shorter.length + longer.length);
}

/** Search products_fts using SQLite FTS5 via the raw better-sqlite3 instance. */
function searchFts(
  db: Db,
  query: string,
  productType: string,
  limit: number,
): Array<{ productId: string; title: string; platform: string; rank: number }> {
  try {
    // Access the underlying better-sqlite3 instance through drizzle's internal session
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqlite = (db as any).session?.client ?? (db as any)._session?.client;
    if (!sqlite) return [];

    const clean = query.replace(/"/g, '""');
    let sql =
      "SELECT product_id, title, platform, rank FROM products_fts WHERE products_fts MATCH ?";
    const params: unknown[] = [clean];

    if (productType) {
      sql += " AND product_type_id = ?";
      params.push(productType);
    }
    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    const rows = (sqlite.prepare(sql).all as (...args: unknown[]) => Array<{
      product_id: string;
      title: string;
      platform: string;
      rank: number;
    }>)(...params);

    return rows.map((r) => ({
      productId: r.product_id,
      title: r.title,
      platform: r.platform,
      rank: r.rank,
    }));
  } catch {
    return [];
  }
}

/**
 * For each extracted item, search the catalog using FTS5.
 *
 * Uses SQLite full-text search for millisecond-level matching against
 * 300K products. Falls back to difflib-style scoring if FTS isn't available.
 *
 * product_type from Stage 1 narrows the search. Platform boosts score.
 *
 * Returns Map<itemIndex, CatalogCandidate[]> with topN candidates per item.
 */
export function matchCandidates(
  extracted: ExtractedItem[],
  db: Db,
  topN = 5,
): Map<number, CatalogCandidate[]> {
  const results = new Map<number, CatalogCandidate[]>();
  if (!extracted.length) return results;

  for (let idx = 0; idx < extracted.length; idx++) {
    const item = extracted[idx];
    const searchTerms = item.platform
      ? `${item.name} ${item.platform}`
      : item.name;

    let candidates: CatalogCandidate[] = [];

    // Try FTS5 first (fast path)
    const ftsResults = searchFts(db, searchTerms, item.productType, topN * 3);
    if (ftsResults.length) {
      // Get prices for FTS results
      const priceMap = new Map<string, number>();
      for (const r of ftsResults) {
        const row = db
          .select({ priceUsd: pricePoints.priceUsd })
          .from(pricePoints)
          .where(
            and(eq(pricePoints.productId, r.productId), eq(pricePoints.condition, "loose")),
          )
          .orderBy(desc(pricePoints.recordedAt))
          .limit(1)
          .all()[0];
        if (row && row.priceUsd > 2) {
          priceMap.set(r.productId, row.priceUsd);
        }
      }

      for (const r of ftsResults) {
        if (!priceMap.has(r.productId)) continue;
        // FTS rank is negative (lower = better), normalize to 0–1
        const ftsScore = Math.min(1.0, Math.max(0.3, 1.0 + r.rank / 10));
        const searchPlat = (item.platform ?? "").toLowerCase();
        const resultPlat = (r.platform ?? "").toLowerCase();
        let score = ftsScore;
        if (
          searchPlat &&
          resultPlat &&
          (searchPlat.includes(resultPlat) || resultPlat.includes(searchPlat))
        ) {
          score = Math.min(1.0, score + 0.15);
        }
        candidates.push({
          productId: r.productId,
          title: r.title,
          platform: r.platform ?? "",
          loosePrice: priceMap.get(r.productId)!,
          score,
        });
      }
    }

    // Fallback: difflib-style scoring (slow path — only if FTS failed)
    if (!candidates.length) {
      const catalog = db
        .select({
          id: products.id,
          title: products.title,
          platform: products.platform,
          priceUsd: pricePoints.priceUsd,
        })
        .from(products)
        .innerJoin(pricePoints, eq(pricePoints.productId, products.id))
        .where(and(eq(pricePoints.condition, "loose"), gt(pricePoints.priceUsd, 2)))
        .orderBy(desc(products.salesVolume))
        .limit(5000)
        .all();

      const searchLower = searchTerms.toLowerCase();
      for (const row of catalog) {
        const score = sequenceRatio(
          searchLower,
          `${row.title} ${row.platform ?? ""}`.toLowerCase(),
        );
        if (score >= 0.4) {
          candidates.push({
            productId: row.id,
            title: row.title,
            platform: row.platform ?? "",
            loosePrice: row.priceUsd,
            score,
          });
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score);
    results.set(idx, candidates.slice(0, topN));
  }

  return results;
}

// ── Stage 3: Confirm via LLM ──────────────────────────────────────────

/**
 * Stage 3: One LLM call to confirm all matches. The gate.
 *
 * Shows the LLM what Stage 1 extracted (including metadata) alongside
 * the catalog candidates from Stage 2. The LLM picks the right match
 * or rejects. Uses product type schema from the DB for the response format.
 */
export async function confirmMatches(
  extracted: ExtractedItem[],
  candidates: Map<number, CatalogCandidate[]>,
  llm: LlmClient | null,
  db: Db,
  listingPrice = 0,
  marketplaceId = "",
): Promise<Array<ConfirmedMatch | null>> {
  // No LLM: use best candidate if score >= 0.7
  if (!llm) {
    return extracted.map((item, i) => {
      const cands = candidates.get(i) ?? [];
      if (cands.length && cands[0].score >= 0.7) {
        return {
          productId: cands[0].productId,
          title: cands[0].title,
          platform: cands[0].platform,
          condition: item.condition,
          marketPrice: cands[0].loosePrice,
          confidence: cands[0].score,
          details: {},
        };
      }
      return null;
    });
  }

  // Build the confirmation prompt with full context
  const lines: string[] = [];
  for (let idx = 0; idx < extracted.length; idx++) {
    const item = extracted[idx];
    const cands = candidates.get(idx) ?? [];

    // Show what Stage 1 extracted, including metadata
    const metaParts = Object.entries(item.metadata)
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${v}`);
    const metaStr = metaParts.length ? ` | ${metaParts.join(", ")}` : "";

    lines.push(
      `Item ${idx + 1}: "${item.name}" ` +
      `(type: ${item.productType}, platform: ${item.platform}, ` +
      `condition: ${item.condition}${metaStr})`,
    );

    if (!cands.length) {
      lines.push("  No catalog matches found → null");
      continue;
    }

    for (let j = 0; j < cands.length; j++) {
      const c = cands[j];
      const matchPct = `${(c.score * 100).toFixed(0)}%`;
      lines.push(
        `  ${String.fromCharCode(65 + j)}) ${c.title} (${c.platform}) ` +
        `— $${c.loosePrice.toFixed(2)} loose [${matchPct} match]`,
      );
    }
    lines.push(`  ${String.fromCharCode(65 + cands.length)}) None of these`);
  }

  // Get valid conditions from DB for the response format
  let conditionHint = "loose, cib, new_sealed, graded";
  if (extracted.length) {
    const ptId = extracted[0].productType;
    if (ptId) {
      const pt = db
        .select()
        .from(productTypes)
        .where(eq(productTypes.id, ptId))
        .limit(1)
        .all()[0];
      if (pt?.conditionSchema?.length) {
        conditionHint = pt.conditionSchema.join(", ");
      }
    }
  }

  const perItemLine =
    extracted.length > 1
      ? `Per-item cost: $${(listingPrice / extracted.length).toFixed(2)}\n`
      : "";

  const prompt =
    "## Context\n\n" +
    "You are the final gate in our arbitrage identification pipeline.\n" +
    "Stage 1 extracted product data from a marketplace listing.\n" +
    "Stage 2 found candidate matches in our 300K product catalog.\n" +
    "Your job: confirm or reject each match.\n\n" +
    `Listing price: $${listingPrice.toFixed(2)} on ${marketplaceId}\n` +
    `Item count: ${extracted.length} items extracted\n` +
    perItemLine +
    "\n" +
    "## Extracted items and catalog candidates\n\n" +
    lines.join("\n") + "\n\n" +
    "## Instructions\n\n" +
    "- Pick the catalog product that BEST matches the extracted item\n" +
    "- Reject (null) if no candidate is the right product\n" +
    "- Reject if the listing is a reproduction, fake, or unrelated item\n" +
    "- Confirm the condition based on the listing context\n" +
    `  Valid conditions: ${conditionHint}\n\n` +
    "## Response\n\n" +
    '{"matches": [{"item": 1, "choice": "A", "condition": "condition_value"}, ...]}\n' +
    "Use null for choice if no match.";

  try {
    const result = await llm.generateJson(prompt, {
      system:
        "You are the quality gate in a collectibles arbitrage system. " +
        "We buy underpriced items on one marketplace and resell at market " +
        "value on another. A false positive here means we buy something " +
        "worthless thinking it's valuable — that costs real money. A false " +
        "negative means we miss a deal — that's fine, there will be more. " +
        "When in doubt, reject. Only confirm matches you're confident about. " +
        "Reply with JSON only.",
    });

    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return new Array<null>(extracted.length).fill(null);
    }

    const matchesRaw = (result as Record<string, unknown>)["matches"];
    if (!Array.isArray(matchesRaw)) return new Array<null>(extracted.length).fill(null);

    const out: Array<ConfirmedMatch | null> = new Array(extracted.length).fill(null);

    for (const m of matchesRaw as Array<Record<string, unknown>>) {
      const idx = (typeof m["item"] === "number" ? m["item"] : 0) - 1;
      const choice = m["choice"];
      const condition = typeof m["condition"] === "string" ? m["condition"] : "loose";

      if (idx < 0 || idx >= extracted.length) continue;
      const cands = candidates.get(idx) ?? [];
      // null choice or "None of these" letter
      if (choice === null || choice === undefined) continue;
      if (
        typeof choice === "string" &&
        choice.toUpperCase() === String.fromCharCode(65 + cands.length)
      )
        continue;

      const candIdx =
        typeof choice === "string" ? choice.toUpperCase().charCodeAt(0) - 65 : -1;
      if (candIdx >= 0 && candIdx < cands.length) {
        const c = cands[candIdx];
        out[idx] = {
          productId: c.productId,
          title: c.title,
          platform: c.platform,
          condition,
          marketPrice: c.loosePrice,
          confidence: c.score,
          details: extracted[idx].metadata,
        };
      }
    }

    return out;
  } catch {
    return new Array<null>(extracted.length).fill(null);
  }
}

// ── Convenience: all three stages in one call ─────────────────────────

/**
 * Run all three stages: extract → match → confirm.
 *
 * listing: RawListing object or string title.
 * Returns list of confirmed matches (may be empty).
 */
export async function identifyAndMatch(
  listing: RawListing | string,
  llm: LlmClient | null,
  db: Db,
): Promise<ConfirmedMatch[]> {
  // Stage 1: Extract (uses full listing data + product type schema from DB)
  const extracted = await extractItems(listing, llm, db);
  if (!extracted.length) return [];

  // Stage 2: Match candidates from catalog (FTS5 if available)
  const candidateMap = matchCandidates(extracted, db);
  if (![...candidateMap.values()].some((v) => v.length)) return [];

  // Stage 3: LLM confirms (uses product type schema from DB + listing price)
  const price =
    typeof listing === "string"
      ? 0
      : listing.price_usd;
  const marketplace =
    typeof listing === "string"
      ? ""
      : listing.marketplace_id;

  const confirmed = await confirmMatches(
    extracted,
    candidateMap,
    llm,
    db,
    price,
    marketplace,
  );
  return confirmed.filter((m): m is ConfirmedMatch => m !== null);
}
