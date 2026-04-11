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

import { eq, desc, and, gt, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { products, productTypes, pricePoints } from "../db/schema";
import { embeddingRepo } from "@/db/repos/EmbeddingRepo";
import { productRepo } from "@/db/repos/ProductRepo";
import { db as sharedDb } from "@/db/client";
import type { LlmClient } from "./helpers";
import type { RawListing } from "../sources/IMarketplaceAdapter";
import { log, skip, error } from "@/lib/logger";

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

  log("identifier/s1", `extracting items from listing`);
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
      "- If the title contains 'custom', 'custom card', 'fan made', 'proxy', " +
      "'replica', 'reprint', 'fake', 'gold plated', or 'gold custom' — " +
      "this is NOT an authentic product. Return empty items. Custom/fan-made " +
      "cards have zero resale value in the real market. Do NOT match them " +
      "to real catalog products.\n" +
      "- If the title mentions 'untested', 'for parts', 'as-is', note that " +
      "in the metadata — it affects value significantly\n" +
      "- TRADING CARDS (Pokemon, MTG, Yu-Gi-Oh): The SET NAME and CARD NUMBER " +
      "are the PRIMARY identifiers. 'Charizard VMAX 020/189 Darkness Ablaze' " +
      "is a completely different product from 'Charizard GX 009/068 Hidden Fates'. " +
      "Always extract: card name, set name, card number (e.g. 020/189), rarity, " +
      "edition (1st edition, unlimited), and language. Include set name and card " +
      "number in the 'name' field (e.g. 'Charizard VMAX 020/189 Darkness Ablaze') " +
      "AND in the metadata fields. Without set/number, we cannot distinguish cards.\n\n" +
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
          "CRITICAL for trading cards: ALWAYS include the SET NAME and CARD " +
          "NUMBER in the name field (e.g. 'Charizard VMAX 020/189 Darkness " +
          "Ablaze'). Without these, the system cannot distinguish between " +
          "the hundreds of different Charizard cards in the catalog. Each " +
          "card in a lot is a DISTINCT product — never use the same name " +
          "for multiple cards. " +
          "Reply with JSON only.",
      },
    );

    if (!result || typeof result !== "object" || Array.isArray(result)) {
      skip("identifier/s1", "LLM returned non-object or null");
      return [];
    }
    const items = (result as Record<string, unknown>)["items"];
    if (!Array.isArray(items)) {
      skip("identifier/s1", "LLM response missing items array");
      return [];
    }

    const extracted = items
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

    log("identifier/s1", `extracted ${extracted.length} item(s):`);
    for (const item of extracted) {
      log("identifier/s1", `  "${item.name}" type=${item.productType} platform=${item.platform || "(none)"} condition=${item.condition} qty=${item.quantity}`);
    }
    return extracted;
  } catch (err) {
    error("identifier/s1", "LLM extraction failed", err);
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
    let idx = -1;
    for (let j = 0; j < longer.length; j++) {
      if (longer[j] === ch && !used[j]) { idx = j; break; }
    }
    if (idx !== -1) {
      matches++;
      used[idx] = true;
    }
  }
  return (2 * matches) / (shorter.length + longer.length);
}

/** Search products_fts using SQLite FTS5 via Drizzle's sql tagged template. */
function searchFts(
  _db: Db,
  query: string,
  productType: string,
  limit: number,
): Array<{ productId: string; title: string; platform: string; rank: number }> {
  try {
    const clean = query.replace(/"/g, '""');

    const rows = productType
      ? sharedDb.all<{
          product_id: string;
          title: string;
          platform: string;
          rank: number;
        }>(sql`SELECT product_id, title, platform, rank FROM products_fts WHERE products_fts MATCH ${clean} AND product_type_id = ${productType} ORDER BY rank LIMIT ${limit}`)
      : sharedDb.all<{
          product_id: string;
          title: string;
          platform: string;
          rank: number;
        }>(sql`SELECT product_id, title, platform, rank FROM products_fts WHERE products_fts MATCH ${clean} ORDER BY rank LIMIT ${limit}`);

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
 * Search products by vector embedding similarity.
 * Computes query embedding via Ollama, then finds nearest neighbors
 * using cosine similarity through the EmbeddingRepo.
 */
async function searchEmbeddings(
  db: Db,
  query: string,
  limit: number,
): Promise<Array<{ productId: string; title: string; platform: string; distance: number }>> {
  try {
    const ollamaUrl = process.env.OLLAMA_URL || "http://battleaxe:11434";

    // Compute query embedding (transient — not stored)
    const resp = await fetch(`${ollamaUrl}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-embedding:8b", input: query }),
    });
    if (!resp.ok) return [];
    const data = (await resp.json()) as { embeddings?: number[][] };
    const queryVec = data.embeddings?.[0];
    if (!queryVec?.length) return [];

    // Find similar products via repo (cosine similarity)
    const similar = await embeddingRepo.findSimilar("product", queryVec, limit);
    if (!similar.length) return [];

    // Hydrate with product details
    const results: Array<{ productId: string; title: string; platform: string; distance: number }> = [];
    for (const match of similar) {
      const product = await productRepo.findById(match.entityId);
      if (product) {
        results.push({
          productId: product.id,
          title: product.title,
          platform: product.platform ?? "",
          distance: match.distance,
        });
      }
    }

    return results;
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
export async function matchCandidates(
  extracted: ExtractedItem[],
  db: Db,
  topN = 5,
): Promise<Map<number, CatalogCandidate[]>> {
  const results = new Map<number, CatalogCandidate[]>();
  if (!extracted.length) return results;

  for (let idx = 0; idx < extracted.length; idx++) {
    const item = extracted[idx];
    // Build search terms — for trading cards, include set name and card number
    // to avoid matching every card to the same generic product
    const isCardType = ["pokemon_card", "mtg_card", "yugioh_card", "onepiece_card", "sports_card"].includes(item.productType);
    let searchTerms = item.name;
    if (isCardType) {
      const setName = item.metadata["set_name"] as string | undefined;
      const cardNumber = item.metadata["card_number"] as string | undefined;
      const rarity = item.metadata["rarity"] as string | undefined;
      if (setName && !searchTerms.toLowerCase().includes(setName.toLowerCase())) {
        searchTerms += ` ${setName}`;
      }
      if (cardNumber && !searchTerms.includes(cardNumber)) {
        searchTerms += ` ${cardNumber}`;
      }
      if (rarity && !searchTerms.toLowerCase().includes(rarity.toLowerCase())) {
        searchTerms += ` ${rarity}`;
      }
    }
    if (item.platform) {
      searchTerms += ` ${item.platform}`;
    }

    log("identifier/s2", `item [${idx + 1}/${extracted.length}]: searching catalog for "${searchTerms}"`);
    let candidates: CatalogCandidate[] = [];

    // Try FTS5 first (fast path)
    const ftsResults = searchFts(db, searchTerms, item.productType, topN * 3);
    if (ftsResults.length) {
      log("identifier/s2", `FTS5 returned ${ftsResults.length} raw results for "${searchTerms}"`);
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
    } else {
      log("identifier/s2", `FTS5 found no results for "${searchTerms}"`);
    }

    // Try embeddings (semantic search — catches typos, abbreviations)
    if (candidates.length < topN) {
      log("identifier/s2", `FTS5 yielded only ${candidates.length} candidates (< topN ${topN}), trying embeddings`);
      try {
        const vecCandidates = await searchEmbeddings(db, searchTerms, topN * 2);
        log("identifier/s2", `embeddings returned ${vecCandidates.length} result(s)`);
        let addedFromVec = 0;
        for (const vc of vecCandidates) {
          // Skip if already found by FTS5
          if (candidates.some((c) => c.productId === vc.productId)) continue;
          // Get price
          const row = db
            .select({ priceUsd: pricePoints.priceUsd })
            .from(pricePoints)
            .where(
              and(eq(pricePoints.productId, vc.productId), eq(pricePoints.condition, "loose")),
            )
            .orderBy(desc(pricePoints.recordedAt))
            .limit(1)
            .all()[0];
          if (row && row.priceUsd > 2) {
            // Convert distance (0=identical, 2=opposite) to score (1=best, 0=worst)
            const score = Math.max(0, 1.0 - vc.distance / 2);
            candidates.push({
              productId: vc.productId,
              title: vc.title,
              platform: vc.platform,
              loosePrice: row.priceUsd,
              score,
            });
            addedFromVec++;
          }
        }
        log("identifier/s2", `embeddings added ${addedFromVec} new candidates`);
      } catch {
        // Embeddings not available — that's fine
        log("identifier/s2", `embeddings unavailable, skipping`);
      }
    }

    // Fallback: difflib-style scoring (slow path — only if nothing else worked)
    if (!candidates.length) {
      log("identifier/s2", `FTS5 + embeddings found nothing, falling back to difflib scan (slow)`);
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
      log("identifier/s2", `difflib found ${candidates.length} candidate(s) for "${searchTerms}"`);
    }

    candidates.sort((a, b) => b.score - a.score);
    const topCandidates = candidates.slice(0, topN);
    if (topCandidates.length) {
      const best = topCandidates[0];
      log("identifier/s2", `${topCandidates.length} candidate(s) for "${item.name}"; top: "${best.title}" (${best.platform}) score=${best.score.toFixed(2)} $${best.loosePrice.toFixed(2)}`);
    } else {
      log("identifier/s2", `no candidates found for "${item.name}"`);
    }
    results.set(idx, topCandidates);
  }

  // Dedup: if the same product is the #1 candidate for multiple items,
  // that's almost certainly an over-match (e.g., every Pokemon card matching
  // "Pokemon Zany Cards"). Demote duplicates so only the highest-scoring
  // item keeps it as #1; others get it pushed down.
  if (extracted.length > 1) {
    const topProductCounts = new Map<string, { bestScore: number; bestIdx: number }>();
    for (const [idx, cands] of results) {
      if (!cands.length) continue;
      const topId = cands[0].productId;
      const topScore = cands[0].score;
      const existing = topProductCounts.get(topId);
      if (!existing || topScore > existing.bestScore) {
        topProductCounts.set(topId, { bestScore: topScore, bestIdx: idx });
      }
    }
    for (const [idx, cands] of results) {
      if (!cands.length) continue;
      const topId = cands[0].productId;
      const best = topProductCounts.get(topId);
      if (best && best.bestIdx !== idx) {
        // This item has the same #1 as another item with a higher score.
        // Remove the duplicate product from this item's candidates entirely.
        const filtered = cands.filter((c) => c.productId !== topId);
        results.set(idx, filtered);
        log("identifier/s2", `dedup: removed "${cands[0].title}" from item ${idx + 1} (duplicate of item ${best.bestIdx + 1})`);
      }
    }
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
    log("identifier/s3", `no LLM — auto-confirming candidates with score >= 0.7`);
    return extracted.map((item, i) => {
      const cands = candidates.get(i) ?? [];
      if (cands.length && cands[0].score >= 0.7) {
        log("identifier/s3", `auto-confirm item ${i + 1}: "${cands[0].title}" score=${cands[0].score.toFixed(2)}`);
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
      log("identifier/s3", `auto-reject item ${i + 1}: "${item.name}" — no candidate scored >= 0.7`);
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

  // Build per-item condition hints from DB
  const defaultConditionHint = "loose, cib, new_sealed, graded";
  const conditionHintMap = new Map<number, string>();
  const ptCache = new Map<string, string>();
  for (let idx = 0; idx < extracted.length; idx++) {
    const ptId = extracted[idx].productType;
    if (ptId) {
      if (!ptCache.has(ptId)) {
        const pt = db
          .select()
          .from(productTypes)
          .where(eq(productTypes.id, ptId))
          .limit(1)
          .all()[0];
        ptCache.set(ptId, pt?.conditionSchema?.length ? pt.conditionSchema.join(", ") : defaultConditionHint);
      }
      conditionHintMap.set(idx, ptCache.get(ptId)!);
    } else {
      conditionHintMap.set(idx, defaultConditionHint);
    }
  }

  // Append per-item valid conditions to the prompt lines
  for (let idx = 0; idx < extracted.length; idx++) {
    lines.push(`  Valid conditions for item ${idx + 1}: ${conditionHintMap.get(idx) ?? defaultConditionHint}`);
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
    "- TRADING CARDS (Pokemon, MTG, Yu-Gi-Oh, etc.): A match is ONLY valid " +
    "if the SET NAME and CARD NUMBER match or are very close. " +
    "'Charizard VMAX 020/189 Darkness Ablaze' does NOT match 'Charizard GX " +
    "009/068 Hidden Fates' — these are completely different products worth " +
    "different amounts. If the catalog candidate is a generic product like " +
    "'Pokemon Zany Cards' or a compilation/accessory and the extracted item " +
    "is a specific card, REJECT the match. Different set = different product.\n" +
    "- Confirm the condition based on the listing context\n" +
    "- Use the valid conditions listed per item above\n\n" +
    "## Response\n\n" +
    '{"matches": [{"item": 1, "choice": "A", "condition": "condition_value"}, ...]}\n' +
    "Use null for choice if no match.";

  log("identifier/s3", `LLM confirmation: ${extracted.length} item(s), ${[...candidates.values()].reduce((s, v) => s + v.length, 0)} total candidates`);

  try {
    const result = await llm.generateJson(prompt, {
      system:
        "You are the quality gate in a collectibles arbitrage system. " +
        "We buy underpriced items on one marketplace and resell at market " +
        "value on another. A false positive here means we buy something " +
        "worthless thinking it's valuable — that costs real money. A false " +
        "negative means we miss a deal — that's fine, there will be more. " +
        "When in doubt, reject. Only confirm matches you're confident about. " +
        "CRITICAL for trading cards: every unique card has a specific set " +
        "name and card number. Do NOT match a specific card to a generic " +
        "product (e.g. 'Pokemon Zany Cards', 'Pokemon Card Game'). Do NOT " +
        "match cards from different sets even if they feature the same " +
        "character. If the set or number doesn't match, reject. " +
        "CRITICAL: if the listing says 'custom', 'custom card', 'fan made', " +
        "'proxy', 'replica', 'reprint', 'gold custom', or 'gold plated' — " +
        "REJECT. These are worthless fakes. A 'Pokemon Gold Custom Pikachu " +
        "Card' is NOT a real Pikachu card. Never match custom/fan-made " +
        "items to real catalog products. " +
        "Reply with JSON only.",
    });

    if (!result || typeof result !== "object" || Array.isArray(result)) {
      log("identifier/s3", `LLM returned invalid response shape`);
      return new Array<null>(extracted.length).fill(null);
    }

    const matchesRaw = (result as Record<string, unknown>)["matches"];
    if (!Array.isArray(matchesRaw)) {
      log("identifier/s3", `LLM response missing matches array`);
      return new Array<null>(extracted.length).fill(null);
    }

    log("identifier/s3", `LLM returned ${matchesRaw.length} match decision(s)`);
    const out: Array<ConfirmedMatch | null> = new Array(extracted.length).fill(null);

    for (const m of matchesRaw as Array<Record<string, unknown>>) {
      const idx = (typeof m["item"] === "number" ? m["item"] : 0) - 1;
      const choice = m["choice"];
      const condition = typeof m["condition"] === "string" ? m["condition"] : "loose";

      if (idx < 0 || idx >= extracted.length) continue;
      const cands = candidates.get(idx) ?? [];
      // null choice or "None of these" letter
      if (choice === null || choice === undefined) {
        log("identifier/s3", `item ${idx + 1} ("${extracted[idx].name}"): LLM rejected (null choice)`);
        continue;
      }
      if (
        typeof choice === "string" &&
        choice.toUpperCase() === String.fromCharCode(65 + cands.length)
      ) {
        log("identifier/s3", `item ${idx + 1} ("${extracted[idx].name}"): LLM chose "None of these"`);
        continue;
      }

      const candIdx =
        typeof choice === "string" ? choice.toUpperCase().charCodeAt(0) - 65 : -1;
      if (candIdx >= 0 && candIdx < cands.length) {
        const c = cands[candIdx];
        log("identifier/s3", `item ${idx + 1} ("${extracted[idx].name}"): LLM confirmed → "${c.title}" (${c.platform}) [${condition}] score=${c.score.toFixed(2)} $${c.loosePrice.toFixed(2)}`);
        out[idx] = {
          productId: c.productId,
          title: c.title,
          platform: c.platform,
          condition,
          marketPrice: c.loosePrice,
          confidence: c.score,
          details: extracted[idx].metadata,
        };
      } else {
        log("identifier/s3", `item ${idx + 1} ("${extracted[idx].name}"): LLM choice "${choice}" invalid`);
      }
    }

    const nConfirmed = out.filter(Boolean).length;
    const nRejected = out.length - nConfirmed;
    log("identifier/s3", `stage 3 result: ${nConfirmed} confirmed, ${nRejected} rejected`);

    return out;
  } catch (err) {
    error("identifier/s3", "LLM confirmation failed", err);
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
  if (!extracted.length) {
    log("identifier", `stage 1 extracted 0 items — skipping stages 2 & 3`);
    return [];
  }
  log("identifier", `stage 1 complete: ${extracted.length} item(s) extracted`);

  // Stage 2: Match candidates from catalog (FTS5 if available)
  const candidateMap = await matchCandidates(extracted, db);
  const totalCandidates = [...candidateMap.values()].reduce((s, v) => s + v.length, 0);
  if (!totalCandidates) {
    log("identifier", `stage 2 found no candidates for any item — skipping stage 3`);
    return [];
  }
  log("identifier", `stage 2 complete: ${totalCandidates} total candidate(s) across ${extracted.length} item(s)`);

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
  const finalMatches = confirmed.filter((m): m is ConfirmedMatch => m !== null);
  log("identifier", `stage 3 complete: ${finalMatches.length} confirmed match(es)`);
  return finalMatches;
}
