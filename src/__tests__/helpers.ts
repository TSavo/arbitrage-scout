/**
 * Test helpers — in-memory SQLite DB with schema for isolated tests.
 */

import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";

export function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  // Create all tables
  sqlite.exec(`
    CREATE TABLE product_types (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      condition_schema TEXT NOT NULL DEFAULT '[]',
      metadata_schema TEXT NOT NULL DEFAULT '[]'
    )
  `);

  sqlite.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      product_type_id TEXT NOT NULL REFERENCES product_types(id),
      title TEXT NOT NULL,
      platform TEXT,
      release_date TEXT,
      genre TEXT,
      sales_volume INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  sqlite.exec(`
    CREATE TABLE product_identifiers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL REFERENCES products(id),
      identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL,
      UNIQUE(product_id, identifier_type, identifier_value)
    )
  `);

  sqlite.exec(`
    CREATE TABLE price_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL REFERENCES products(id),
      source TEXT NOT NULL,
      condition TEXT NOT NULL,
      price_usd REAL NOT NULL,
      recorded_at TEXT NOT NULL,
      UNIQUE(product_id, source, condition, recorded_at)
    )
  `);

  sqlite.exec(`
    CREATE TABLE marketplaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL DEFAULT '',
      supports_api INTEGER NOT NULL DEFAULT 0
    )
  `);

  sqlite.exec(`
    CREATE TABLE listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      marketplace_id TEXT NOT NULL REFERENCES marketplaces(id),
      marketplace_listing_id TEXT NOT NULL,
      url TEXT,
      title TEXT NOT NULL,
      description TEXT,
      price_usd REAL NOT NULL,
      shipping_usd REAL NOT NULL DEFAULT 0,
      seller TEXT,
      is_lot INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      UNIQUE(marketplace_id, marketplace_listing_id)
    )
  `);

  sqlite.exec(`
    CREATE TABLE listing_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES listings(id),
      product_id TEXT NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      condition TEXT NOT NULL DEFAULT 'loose',
      condition_details TEXT NOT NULL DEFAULT '{}',
      estimated_value_usd REAL,
      confidence REAL NOT NULL DEFAULT 0,
      confirmed INTEGER NOT NULL DEFAULT 0,
      raw_extraction TEXT DEFAULT '{}',
      UNIQUE(listing_id, product_id)
    )
  `);

  sqlite.exec(`
    CREATE TABLE opportunities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL REFERENCES listings(id),
      product_id TEXT NOT NULL REFERENCES products(id),
      listing_price_usd REAL NOT NULL,
      market_price_usd REAL NOT NULL,
      market_price_source TEXT NOT NULL,
      market_price_condition TEXT NOT NULL,
      profit_usd REAL NOT NULL,
      margin_pct REAL NOT NULL,
      fees_usd REAL NOT NULL DEFAULT 0,
      confidence REAL NOT NULL DEFAULT 0,
      flags TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'new',
      found_at TEXT NOT NULL,
      reviewed_at TEXT,
      notes TEXT,
      buy_price_usd REAL,
      sale_price_usd REAL,
      sale_date TEXT,
      actual_fees_usd REAL,
      potential_profit_usd REAL,
      potential_margin_pct REAL,
      UNIQUE(listing_id, product_id)
    )
  `);

  sqlite.exec(`
    CREATE TABLE scan_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      marketplace_id TEXT REFERENCES marketplaces(id),
      queries_run INTEGER NOT NULL DEFAULT 0,
      listings_found INTEGER NOT NULL DEFAULT 0,
      opportunities_found INTEGER NOT NULL DEFAULT 0,
      rate_limited INTEGER NOT NULL DEFAULT 0,
      error TEXT
    )
  `);

  sqlite.exec(`
    CREATE TABLE embeddings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      embedded_at TEXT NOT NULL,
      UNIQUE(entity_type, entity_id)
    )
  `);

  sqlite.exec(`
    CREATE TABLE watchlist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id TEXT NOT NULL REFERENCES products(id),
      target_price_pct REAL NOT NULL,
      condition TEXT NOT NULL DEFAULT 'loose',
      created_at TEXT NOT NULL,
      triggered_at TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT
    )
  `);

  const db = drizzle(sqlite, { schema });

  return { sqlite, db };
}

/** Seed minimal test data */
export function seedTestData(db: BetterSQLite3Database<typeof schema>) {
  const now = new Date().toISOString();

  // Product types
  db.insert(schema.productTypes).values({
    id: "retro_game",
    name: "Retro Video Game",
    conditionSchema: ["loose", "cib", "new_sealed"],
    metadataSchema: ["region", "variant"],
  }).run();

  db.insert(schema.productTypes).values({
    id: "pokemon_card",
    name: "Pokemon Card",
    conditionSchema: ["loose", "graded"],
    metadataSchema: ["set_name", "card_number"],
  }).run();

  // Marketplaces
  db.insert(schema.marketplaces).values({ id: "shopgoodwill", name: "ShopGoodwill", baseUrl: "https://shopgoodwill.com", supportsApi: true }).run();
  db.insert(schema.marketplaces).values({ id: "hibid", name: "HiBid", baseUrl: "https://hibid.com", supportsApi: true }).run();
  db.insert(schema.marketplaces).values({ id: "ebay", name: "eBay", baseUrl: "https://ebay.com", supportsApi: true }).run();

  // Products
  db.insert(schema.products).values({
    id: "pc-1", productTypeId: "retro_game", title: "Super Mario 64",
    platform: "Nintendo 64", salesVolume: 5000, createdAt: now, updatedAt: now,
  }).run();

  db.insert(schema.products).values({
    id: "pc-2", productTypeId: "retro_game", title: "GoldenEye 007",
    platform: "Nintendo 64", salesVolume: 3000, createdAt: now, updatedAt: now,
  }).run();

  db.insert(schema.products).values({
    id: "pc-3", productTypeId: "pokemon_card", title: "Charizard VMAX",
    platform: "Pokemon Darkness Ablaze", salesVolume: 8000, createdAt: now, updatedAt: now,
  }).run();

  // Price points
  db.insert(schema.pricePoints).values({ productId: "pc-1", source: "pricecharting", condition: "loose", priceUsd: 25.00, recordedAt: "2026-04-10" }).run();
  db.insert(schema.pricePoints).values({ productId: "pc-1", source: "pricecharting", condition: "cib", priceUsd: 45.00, recordedAt: "2026-04-10" }).run();
  db.insert(schema.pricePoints).values({ productId: "pc-2", source: "pricecharting", condition: "loose", priceUsd: 15.00, recordedAt: "2026-04-10" }).run();
  db.insert(schema.pricePoints).values({ productId: "pc-3", source: "pricecharting", condition: "loose", priceUsd: 150.00, recordedAt: "2026-04-10" }).run();

  return { now };
}
