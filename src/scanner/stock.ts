/**
 * Phase 1: Stock the catalog from PriceCharting CSV dumps.
 *
 * Loads PriceCharting CSV exports, creates Product, ProductIdentifier,
 * and PricePoint rows. Skips existing products (dedup by product ID).
 * After loading, rebuilds the FTS5 full-text search index.
 */

import * as fs from "fs";
import * as readline from "readline";
import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  products,
  productIdentifiers,
  pricePoints,
  marketplaces,
  taxonomyNodes,
} from "@/db/schema";
import { cfg } from "./helpers";
import { log, section, progress } from "@/lib/logger";
import { loadTcgPlayerPrices } from "../sources/tcgplayer";
import { CATEGORIES } from "../sources/tcgcsv";
import { embeddingRepo } from "@/db/repos/EmbeddingRepo";

interface CsvResult {
  count: number;
  newProducts: { id: string; text: string }[];
}

type Config = Record<string, unknown>;

// ── Constants ─────────────────────────────────────────────────────────

/** Map CSV path → PriceCharting category name */
const CSV_FILES: Record<string, string> = {
  "/tmp/pc-videogames.csv": "videogames",
  "/tmp/pc-pokemon.csv": "pokemon",
  "/tmp/pc-magic.csv": "magic",
  "/tmp/pc-yugioh.csv": "yugioh",
  "/tmp/pc-onepiece.csv": "onepiece",
  "/tmp/pc-funko.csv": "funko",
  "/tmp/pc-lego.csv": "lego",
  "/tmp/pc-comics.csv": "comics",
  "/tmp/pc-coins.csv": "coins",
};

/** Map PriceCharting CSV category → canonical taxonomy path. */
const CSV_TAXONOMY_PATH: Record<string, string> = {
  videogames: "/electronics/video_games/physical_game_media",
  pokemon: "/collectibles/trading_cards/pokemon",
  magic: "/collectibles/trading_cards/mtg",
  yugioh: "/collectibles/trading_cards/yugioh",
  onepiece: "/collectibles/trading_cards/one_piece",
  funko: "/collectibles/figures/funko_pop",
  lego: "/toys_games/building_sets/lego",
  comics: "/collectibles/comic_books",
  coins: "/collectibles/coins",
};

async function resolveTaxonomyNodeId(path: string): Promise<number | null> {
  const node = await db.query.taxonomyNodes.findFirst({
    where: eq(taxonomyNodes.pathCache, path),
    columns: { id: true },
  });
  return node?.id ?? null;
}

/** PriceCharting condition field → our condition name */
const CONDITION_MAP: Record<string, string> = {
  "loose-price": "loose",
  "cib-price": "cib",
  "new-price": "new_sealed",
  "graded-price": "graded",
  "box-only-price": "box_only",
  "manual-only-price": "manual_only",
};

// ── Helpers ───────────────────────────────────────────────────────────

function parseDollar(raw: string): number | null {
  const cleaned = raw.replace("$", "").replace(",", "").trim();
  if (!cleaned) return null;
  const val = parseFloat(cleaned);
  return isFinite(val) && val > 0 ? val : null;
}

/** Naive CSV row parser — handles quoted fields with commas inside. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === "," && !inQuotes) {
      fields.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  fields.push(current);
  return fields;
}

// ── Seeding ───────────────────────────────────────────────────────────

async function seedMarketplaces(): Promise<void> {
  const defaults: (typeof marketplaces.$inferInsert)[] = [
    { id: "ebay", name: "eBay", baseUrl: "https://www.ebay.com", supportsApi: true },
    { id: "pricecharting", name: "PriceCharting", baseUrl: "https://www.pricecharting.com", supportsApi: true },
    { id: "mercari", name: "Mercari", baseUrl: "https://www.mercari.com", supportsApi: false },
  ];
  for (const mp of defaults) {
    const existing = await db
      .select({ id: marketplaces.id })
      .from(marketplaces)
      .where(eq(marketplaces.id, mp.id))
      .limit(1);
    if (!existing.length) {
      await db.insert(marketplaces).values(mp);
    }
  }
}

// ── CSV loader ────────────────────────────────────────────────────────

async function loadCsv(
  csvPath: string,
  category: string,
): Promise<CsvResult> {
  log("stock", `loading CSV: ${csvPath} (category: ${category})`);
  const path = CSV_TAXONOMY_PATH[category];
  if (!path) {
    throw new Error(`stock: no taxonomy path mapped for CSV category "${category}"`);
  }
  const taxonomyNodeId = await resolveTaxonomyNodeId(path);
  if (!taxonomyNodeId) {
    throw new Error(`stock: taxonomy node not found for path "${path}" (run seed-taxonomy first)`);
  }
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const now = new Date().toISOString();

  // Load existing IDs for fast dedup
  const existingRows = await db
    .select({ id: products.id })
    .from(products);
  const existingIds = new Set<string>(existingRows.map((r) => r.id));
  log("stock", `dedup set: ${existingIds.size} existing products in DB`);

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(csvPath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let headers: string[] = [];
    let stocked = 0;
    let lineNo = 0;
    let totalLines = 0;

    const productsBatch: (typeof products.$inferInsert)[] = [];
    const identifiersBatch: (typeof productIdentifiers.$inferInsert)[] = [];
    const pricesBatch: (typeof pricePoints.$inferInsert)[] = [];
    const newProducts: { id: string; text: string }[] = [];

    // totalLines stays 0 — progress function handles unknown total gracefully.
    // Previously used readFileSync to count lines, but that doubled memory usage.

    async function flushBatch(): Promise<void> {
      if (!productsBatch.length) return;
      // Snapshot the buffers and clear them BEFORE the await so concurrent
      // line events can keep filling without seeing in-flight rows twice.
      const pBatch = productsBatch.slice();
      const iBatch = identifiersBatch.slice();
      const ppBatch = pricesBatch.slice();
      productsBatch.length = 0;
      identifiersBatch.length = 0;
      pricesBatch.length = 0;
      await db.transaction(async (tx) => {
        if (pBatch.length) await tx.insert(products).values(pBatch).onConflictDoNothing();
        if (iBatch.length) await tx.insert(productIdentifiers).values(iBatch).onConflictDoNothing();
        if (ppBatch.length) await tx.insert(pricePoints).values(ppBatch).onConflictDoNothing();
      });
    }

    rl.on("line", (line) => {
      if (!line.trim()) return;

      if (lineNo === 0) {
        headers = parseCsvLine(line);
        lineNo++;
        return;
      }
      lineNo++;

      const values = parseCsvLine(line);
      const row: Record<string, string> = {};
      for (let i = 0; i < headers.length; i++) {
        row[headers[i]] = values[i] ?? "";
      }

      const pcId = row["id"] ?? "";
      const name = row["product-name"] ?? "";
      const consoleName = row["console-name"] ?? "";

      if (!name || !pcId) return;

      const productId = `pc-${pcId}`;
      if (existingIds.has(productId)) return;
      existingIds.add(productId);

      // Parse prices
      const prices: Record<string, number> = {};
      for (const [csvField, condition] of Object.entries(CONDITION_MAP)) {
        const val = parseDollar(row[csvField] ?? "");
        if (val !== null) prices[condition] = val;
      }
      if (!Object.keys(prices).length) return;

      const volStr = row["sales-volume"] ?? "0";
      const volume = parseInt(volStr, 10) || 0;

      productsBatch.push({
        id: productId,
        taxonomyNodeId,
        title: name,
        platform: consoleName || null,
        releaseDate: row["release-date"] || null,
        genre: row["genre"] || null,
        salesVolume: volume,
        createdAt: now,
        updatedAt: now,
      });

      newProducts.push({ id: productId, text: `${name} ${consoleName || ""}`.trim() });

      identifiersBatch.push({
        productId,
        identifierType: "pricecharting",
        identifierValue: pcId,
      });
      if (row["upc"]) {
        identifiersBatch.push({
          productId,
          identifierType: "upc",
          identifierValue: row["upc"],
        });
      }
      if (row["asin"]) {
        identifiersBatch.push({
          productId,
          identifierType: "asin",
          identifierValue: row["asin"],
        });
      }
      if (row["epid"]) {
        identifiersBatch.push({
          productId,
          identifierType: "epid",
          identifierValue: row["epid"],
        });
      }

      for (const [condition, price] of Object.entries(prices)) {
        pricesBatch.push({
          productId,
          source: "pricecharting",
          condition,
          priceUsd: price,
          recordedAt: today,
        });
      }

      if (productsBatch.length >= 5000) {
        const batchCount = productsBatch.length;
        rl.pause();
        flushBatch()
          .then(() => {
            stocked += batchCount;
            progress(stocked, totalLines, `${category} rows loaded`);
            rl.resume();
          })
          .catch(reject);
      }
    });

    rl.on("close", () => {
      const finalCount = productsBatch.length;
      flushBatch()
        .then(() => {
          stocked += finalCount;
          progress(totalLines || stocked, totalLines || stocked, `${category} rows loaded`);
          log("stock", `CSV load complete: ${stocked} products loaded from ${csvPath}`);
          resolve({ count: stocked, newProducts });
        })
        .catch(reject);
    });

    rl.on("error", reject);
    stream.on("error", reject);
  });
}

// ── Entry point ───────────────────────────────────────────────────────

/**
 * Load PriceCharting CSV dumps into the schema.
 *
 * Delegates heavy lifting to loadCsv, then rebuilds FTS index.
 * Returns total number of products loaded.
 */
export async function runStock(config: Config): Promise<number> {
  await seedMarketplaces();

  let total = 0;
  const allNewProducts: { id: string; text: string }[] = [];

  const availableCsvs = Object.entries(CSV_FILES).filter(([csvPath]) => fs.existsSync(csvPath));
  const missingCsvs = Object.entries(CSV_FILES).filter(([csvPath]) => !fs.existsSync(csvPath));
  for (const [csvPath] of missingCsvs) {
    log("stock", `CSV not found, skipping: ${csvPath}`);
  }
  log("stock", `${availableCsvs.length} CSV file(s) to load`);

  for (const [csvPath, category] of availableCsvs) {
    section(`STOCK: ${category.toUpperCase()}`);
    const result = await loadCsv(csvPath, category);
    total += result.count;
    allNewProducts.push(...result.newProducts);
    log("stock", `${category}: ${result.count} products loaded from ${csvPath.split("/").pop()}`);
  }

  // Load TCGplayer prices as a second pricing source alongside PriceCharting.
  // Only runs when at least some products are in the catalog (from CSV or prior runs).
  const tcgEnabled = cfg(config, "tcgplayer", "enabled", true);
  if (tcgEnabled) {
    section("TCGPLAYER PRICE LOAD");
    const tcgCategories: number[] = cfg(config, "tcgplayer", "categories", [
      CATEGORIES.pokemon,
      CATEGORIES.mtg,
      CATEGORIES.yugioh,
      CATEGORIES.one_piece,
    ]);
    log("stock", `loading TCGplayer prices for categories=[${tcgCategories.join(",")}]`);
    try {
      const tcgTotal = await loadTcgPlayerPrices(tcgCategories);
      log("stock", `TCGplayer price load complete: ${tcgTotal} price point(s) inserted`);
    } catch (err) {
      // Non-fatal: CSV data is already loaded; log and continue.
      const msg = err instanceof Error ? err.message : String(err);
      log("stock", `TCGplayer price load failed (non-fatal): ${msg}`);
    }
  } else {
    log("stock", "TCGplayer price load skipped (tcgplayer.enabled=false in config)");
  }

  // Embed just the new products (delta, not full catalog scan)
  if (allNewProducts.length > 0) {
    section("EMBED NEW PRODUCTS");
    const ollamaUrl = process.env.OLLAMA_URL || "http://battleaxe:11434";
    const BATCH_SIZE = 50;
    let embedded = 0;
    log("stock", `embedding ${allNewProducts.length} new products (batch ${BATCH_SIZE})`);

    for (let i = 0; i < allNewProducts.length; i += BATCH_SIZE) {
      const batch = allNewProducts.slice(i, i + BATCH_SIZE);
      try {
        const n = await embeddingRepo.batchEmbed("product", batch, ollamaUrl);
        embedded += n;
      } catch {
        // Non-fatal — bulk embed job will catch stragglers
      }
      progress(i + batch.length, allNewProducts.length, "new products embedded");
    }
    log("stock", `embedded ${embedded} new products`);
  } else {
    log("stock", "no new products to embed");
  }

  section("STOCK COMPLETE");
  log("stock", `total: ${total} products stocked from CSV`);
  return total;
}
