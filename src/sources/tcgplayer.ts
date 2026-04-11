/**
 * TCGplayer price loader via TCGCSV mirror.
 *
 * Bulk-loads TCGplayer prices into the price_points table as a second
 * pricing source alongside PriceCharting. Uses TcgCsvSource to fetch
 * products+prices, matches them to our products by TCGplayer ID (stored
 * in product_identifiers) or by normalized name, then upserts price_points
 * with source="tcgplayer".
 *
 * Condition mapping (TCGCSV subTypeName → our condition):
 *   "Normal"              → "loose"
 *   "Holofoil"            → "foil"
 *   "Reverse Holofoil"    → "reverse_foil"
 *   "1st Edition Holofoil"→ "first_edition_foil"
 *   (others skipped)
 */

import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { products, productIdentifiers, pricePoints } from "@/db/schema";
import { TcgCsvSource, CATEGORIES } from "./tcgcsv";
import { log, error, section, progress } from "@/lib/logger";

// ── Condition mapping ─────────────────────────────────────────────────

const SUBTYPE_CONDITION_MAP: Record<string, string> = {
  "Normal": "loose",
  "Holofoil": "foil",
  "Reverse Holofoil": "reverse_foil",
  "1st Edition Holofoil": "first_edition_foil",
  "1st Edition Normal": "first_edition",
};

/** Normalize a product name for fuzzy matching: lowercase, strip punctuation, collapse spaces */
function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Core loader ───────────────────────────────────────────────────────

/**
 * Load TCGplayer prices from TCGCSV into price_points.
 *
 * @param categories  Category IDs to load. Defaults to Pokemon, MTG, YuGiOh, One Piece.
 */
export async function loadTcgPlayerPrices(
  categories: number[] = [
    CATEGORIES.pokemon,   // 3
    CATEGORIES.mtg,       // 1
    CATEGORIES.yugioh,    // 2
    CATEGORIES.one_piece, // 68
  ],
): Promise<number> {
  const source = new TcgCsvSource();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  let totalInserted = 0;

  // Build name → productId lookup map from our products table for fuzzy match fallback.
  // Built lazily per category to keep memory manageable.
  log("tcgplayer", `loadTcgPlayerPrices: categories=[${categories.join(",")}]`);

  for (const categoryId of categories) {
    section(`TCGPLAYER: category ${categoryId}`);
    log("tcgplayer", `fetching groups for categoryId=${categoryId}`);

    let groups: Record<string, unknown>[];
    try {
      groups = await source.getGroups(categoryId);
    } catch (err) {
      error("tcgplayer", `failed to fetch groups for categoryId=${categoryId}`, err);
      continue;
    }

    log("tcgplayer", `categoryId=${categoryId}: ${groups.length} group(s) to process`);

    // Build a product name map for this category to support name-based fallback matching.
    const nameToProductId = new Map<string, string>();
    try {
      const allProducts = db
        .select({ id: products.id, title: products.title })
        .from(products)
        .all();
      for (const p of allProducts) {
        nameToProductId.set(normalizeName(p.title), p.id);
      }
      log("tcgplayer", `name map: ${nameToProductId.size} products indexed`);
    } catch (err) {
      error("tcgplayer", "failed to build name map, will rely on identifier lookup only", err);
    }

    let groupIdx = 0;
    for (const group of groups) {
      groupIdx++;
      const groupId = group.groupId as number;
      const groupName = (group.name as string) ?? String(groupId);

      progress(groupIdx, groups.length, `category ${categoryId} groups`);

      let rows: Awaited<ReturnType<typeof source.getProductsAndPrices>>;
      try {
        rows = await source.getProductsAndPrices(categoryId, groupId);
      } catch (err) {
        error("tcgplayer", `getProductsAndPrices ${categoryId}/${groupId} failed`, err);
        continue;
      }

      if (!rows.length) continue;

      const batch: (typeof pricePoints.$inferInsert)[] = [];

      for (const row of rows) {
        const condition = SUBTYPE_CONDITION_MAP[row.subTypeName];
        if (!condition) continue;

        // Use marketPrice if available, else lowPrice
        const price = row.marketPrice ?? row.lowPrice;
        if (price === null || price <= 0) continue;

        // 1. Look up by TCGplayer product ID in product_identifiers
        let productId: string | null = null;

        try {
          const byId = db
            .select({ productId: productIdentifiers.productId })
            .from(productIdentifiers)
            .where(
              and(
                eq(productIdentifiers.identifierType, "tcgplayer"),
                eq(productIdentifiers.identifierValue, String(row.productId)),
              ),
            )
            .limit(1)
            .all()[0];

          if (byId) {
            productId = byId.productId;
          }
        } catch (err) {
          error("tcgplayer", `identifier lookup failed productId=${row.productId}`, err);
        }

        // 2. Fallback: normalized name match
        if (!productId && row.name) {
          const normalized = normalizeName(row.name);
          productId = nameToProductId.get(normalized) ?? null;

          if (productId) {
            log(
              "tcgplayer",
              `name match: tcgplayer productId=${row.productId} "${row.name}" → ${productId}`,
            );
          }
        }

        if (!productId) {
          // Product not in our catalog yet — skip (catalog is built from PriceCharting CSVs)
          continue;
        }

        batch.push({
          productId,
          source: "tcgplayer",
          condition,
          priceUsd: price,
          recordedAt: today,
        });
      }

      if (batch.length) {
        db.transaction((tx) => {
          for (const row of batch) {
            tx.insert(pricePoints).values(row).onConflictDoNothing().run();
          }
        });
        totalInserted += batch.length;
        log(
          "tcgplayer",
          `group "${groupName}" (${groupId}): inserted ${batch.length} price point(s)`,
        );
      }
    }

    log("tcgplayer", `categoryId=${categoryId} complete: ${totalInserted} total price points so far`);
  }

  log("tcgplayer", `loadTcgPlayerPrices complete: ${totalInserted} price point(s) inserted`);
  return totalInserted;
}
