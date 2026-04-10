/**
 * Phase 1: Stock the catalog from PriceCharting CSV dumps.
 *
 * Loads PriceCharting CSV exports, creates Product, ProductIdentifier,
 * and PricePoint rows. Skips existing products (dedup by product ID).
 * After loading, rebuilds the FTS5 full-text search index.
 */

import * as fs from "fs";
import * as readline from "readline";
import { resolve } from "path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema";
import {
  products,
  productTypes,
  productIdentifiers,
  pricePoints,
  marketplaces,
} from "../db/schema";
import { cfg } from "./helpers";
import { log, section, progress } from "@/lib/logger";

type Config = Record<string, unknown>;

// ── Constants ─────────────────────────────────────────────────────────

/** Map CSV path → PriceCharting category name */
const CSV_FILES: Record<string, string> = {
  "/tmp/pc-videogames.csv": "videogames",
  "/tmp/pc-pokemon.csv": "pokemon",
  "/tmp/pc-magic.csv": "magic",
};

/** Map PriceCharting CSV category → product_type_id */
const CSV_CATEGORY_MAP: Record<string, string> = {
  videogames: "retro_game",
  pokemon: "pokemon_card",
  magic: "mtg_card",
};

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

function openDb(dbPath: string) {
  const sqlite = new Database(resolve(dbPath));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

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

type Db = ReturnType<typeof drizzle<typeof schema>>;

// ── Seeding ───────────────────────────────────────────────────────────

function seedProductTypes(db: Db): void {
  const defaults: (typeof productTypes.$inferInsert)[] = [
    {
      id: "retro_game",
      name: "Retro Video Game",
      conditionSchema: ["loose", "cib", "new_sealed", "graded", "box_only", "manual_only"],
      metadataSchema: ["region", "variant"],
    },
    {
      id: "pokemon_card",
      name: "Pokemon Card",
      conditionSchema: ["loose", "graded"],
      metadataSchema: ["edition", "holo_type", "language", "grade", "grading_company"],
    },
    {
      id: "mtg_card",
      name: "Magic: The Gathering Card",
      conditionSchema: ["loose", "foil", "graded"],
      metadataSchema: ["set_name", "foil", "language", "grade", "grading_company"],
    },
    {
      id: "sports_card",
      name: "Sports Card",
      conditionSchema: ["loose", "graded"],
      metadataSchema: ["player", "year", "brand", "variant", "grade", "grading_company"],
    },
    {
      id: "comic",
      name: "Comic Book",
      conditionSchema: ["loose", "graded"],
      metadataSchema: ["publisher", "issue", "year", "grade", "grading_company"],
    },
  ];

  for (const pt of defaults) {
    const existing = db
      .select({ id: productTypes.id })
      .from(productTypes)
      .where(eq(productTypes.id, pt.id))
      .limit(1)
      .all();
    if (!existing.length) {
      db.insert(productTypes).values(pt).run();
    }
  }
}

function seedMarketplaces(db: Db): void {
  const defaults: (typeof marketplaces.$inferInsert)[] = [
    { id: "ebay", name: "eBay", baseUrl: "https://www.ebay.com", supportsApi: true },
    { id: "pricecharting", name: "PriceCharting", baseUrl: "https://www.pricecharting.com", supportsApi: true },
    { id: "mercari", name: "Mercari", baseUrl: "https://www.mercari.com", supportsApi: false },
  ];
  for (const mp of defaults) {
    const existing = db
      .select({ id: marketplaces.id })
      .from(marketplaces)
      .where(eq(marketplaces.id, mp.id))
      .limit(1)
      .all();
    if (!existing.length) {
      db.insert(marketplaces).values(mp).run();
    }
  }
}

// ── FTS5 index ────────────────────────────────────────────────────────

function rebuildFtsIndex(sqlite: Database.Database): void {
  log("stock", "rebuilding FTS5 search index...");
  const start = Date.now();
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS products_fts USING fts5(
      product_id,
      title,
      platform,
      product_type_id,
      content='products',
      content_rowid='rowid'
    )
  `);
  sqlite.exec("DELETE FROM products_fts");
  sqlite.exec(`
    INSERT INTO products_fts(product_id, title, platform, product_type_id)
    SELECT id, title, platform, product_type_id FROM products
  `);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log("stock", `FTS5 index rebuilt in ${elapsed}s`);
}

// ── CSV loader ────────────────────────────────────────────────────────

async function loadCsv(
  csvPath: string,
  category: string,
  sqlite: Database.Database,
  db: Db,
): Promise<number> {
  log("stock", `loading CSV: ${csvPath} (category: ${category})`);
  const productTypeId = CSV_CATEGORY_MAP[category] ?? category;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const now = new Date().toISOString();

  // Load existing IDs for fast dedup
  const existingIds = new Set<string>(
    (sqlite.prepare("SELECT id FROM products").all() as { id: string }[]).map(
      (r) => r.id,
    ),
  );
  log("stock", `dedup set: ${existingIds.size} existing products in DB`);

  // Prepare batch insert statements
  const insertProduct = sqlite.prepare(`
    INSERT OR IGNORE INTO products
      (id, product_type_id, title, platform, release_date, genre, sales_volume, created_at, updated_at)
    VALUES (@id, @product_type_id, @title, @platform, @release_date, @genre, @sales_volume, @created_at, @updated_at)
  `);
  const insertIdentifier = sqlite.prepare(`
    INSERT OR IGNORE INTO product_identifiers (product_id, identifier_type, identifier_value)
    VALUES (@product_id, @identifier_type, @identifier_value)
  `);
  const insertPrice = sqlite.prepare(`
    INSERT OR IGNORE INTO price_points (product_id, source, condition, price_usd, recorded_at)
    VALUES (@product_id, @source, @condition, @price_usd, @recorded_at)
  `);

  const flushProducts = sqlite.transaction(
    (
      productsBatch: Record<string, unknown>[],
      identifiersBatch: Record<string, unknown>[],
      pricesBatch: Record<string, unknown>[],
    ) => {
      for (const p of productsBatch) insertProduct.run(p);
      for (const i of identifiersBatch) insertIdentifier.run(i);
      for (const p of pricesBatch) insertPrice.run(p);
    },
  );

  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(csvPath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    let headers: string[] = [];
    let stocked = 0;
    let lineNo = 0;
    let totalLines = 0;

    const productsBatch: Record<string, unknown>[] = [];
    const identifiersBatch: Record<string, unknown>[] = [];
    const pricesBatch: Record<string, unknown>[] = [];

    // Count total lines for progress reporting (non-blocking, best-effort)
    try {
      const content = fs.readFileSync(csvPath, "utf8");
      totalLines = content.split("\n").filter((l) => l.trim()).length - 1; // subtract header
      log("stock", `CSV row count: ${totalLines} data rows`);
    } catch {
      // If we can't pre-count, progress will show 0/0
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
        product_type_id: productTypeId,
        title: name,
        platform: consoleName || null,
        release_date: row["release-date"] || null,
        genre: row["genre"] || null,
        sales_volume: volume,
        created_at: now,
        updated_at: now,
      });

      identifiersBatch.push({
        product_id: productId,
        identifier_type: "pricecharting",
        identifier_value: pcId,
      });
      if (row["upc"]) {
        identifiersBatch.push({
          product_id: productId,
          identifier_type: "upc",
          identifier_value: row["upc"],
        });
      }
      if (row["asin"]) {
        identifiersBatch.push({
          product_id: productId,
          identifier_type: "asin",
          identifier_value: row["asin"],
        });
      }
      if (row["epid"]) {
        identifiersBatch.push({
          product_id: productId,
          identifier_type: "epid",
          identifier_value: row["epid"],
        });
      }

      for (const [condition, price] of Object.entries(prices)) {
        pricesBatch.push({
          product_id: productId,
          source: "pricecharting",
          condition,
          price_usd: price,
          recorded_at: today,
        });
      }

      if (productsBatch.length >= 5000) {
        flushProducts(
          productsBatch.splice(0),
          identifiersBatch.splice(0),
          pricesBatch.splice(0),
        );
        stocked += 5000;
        progress(stocked, totalLines, `${category} rows loaded`);
      }
    });

    rl.on("close", () => {
      if (productsBatch.length) {
        stocked += productsBatch.length;
        flushProducts(
          productsBatch.splice(0),
          identifiersBatch.splice(0),
          pricesBatch.splice(0),
        );
      }
      progress(totalLines || stocked, totalLines || stocked, `${category} rows loaded`);
      log("stock", `CSV load complete: ${stocked} products loaded from ${csvPath}`);
      resolve(stocked);
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
  const dbPath = cfg(config, "database", "path", "data/scout.db");
  const { sqlite, db } = openDb(dbPath);

  seedProductTypes(db);
  seedMarketplaces(db);

  let total = 0;

  const availableCsvs = Object.entries(CSV_FILES).filter(([csvPath]) => fs.existsSync(csvPath));
  const missingCsvs = Object.entries(CSV_FILES).filter(([csvPath]) => !fs.existsSync(csvPath));
  for (const [csvPath] of missingCsvs) {
    log("stock", `CSV not found, skipping: ${csvPath}`);
  }
  log("stock", `${availableCsvs.length} CSV file(s) to load`);

  for (const [csvPath, category] of availableCsvs) {
    section(`STOCK: ${category.toUpperCase()}`);
    const n = await loadCsv(csvPath, category, sqlite, db);
    total += n;
    log("stock", `${category}: ${n} products loaded from ${csvPath.split("/").pop()}`);
  }

  if (total > 0) {
    section("FTS5 INDEX REBUILD");
    rebuildFtsIndex(sqlite);
  }

  section("STOCK COMPLETE");
  log("stock", `total: ${total} products stocked from CSV`);
  return total;
}
