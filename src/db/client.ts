import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { resolve } from "path";
import { log } from "@/lib/logger";

const DB_PATH = process.env.DB_PATH || resolve("data/scout-v2.db");

log("db/client", `opening DB at ${DB_PATH}`);
const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
log("db/client", "pragmas set: journal_mode=WAL foreign_keys=ON");

// Ensure watchlist_items table exists
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS watchlist_items (
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
sqlite.exec(`
  CREATE INDEX IF NOT EXISTS ix_watchlist_active ON watchlist_items(active, product_id)
`);

// Ensure embeddings table exists
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS embeddings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    embedding BLOB NOT NULL,
    embedded_at TEXT NOT NULL
  )
`);
sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_embeddings_entity ON embeddings(entity_type, entity_id)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS ix_embeddings_type ON embeddings(entity_type)`);

// Load sqlite-vec extension for vector similarity search
try {
  const sqliteVec = require("sqlite-vec");
  sqliteVec.load(sqlite);
  // Create virtual table for vector search (4096-dim float32)
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS vec_embeddings USING vec0(
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      embedding float[4096]
    )
  `);
  log("db/client", "sqlite-vec loaded, vec_embeddings virtual table ready");
} catch (err) {
  log("db/client", `sqlite-vec not available (vector search disabled): ${err}`);
}

// Add portfolio columns to opportunities (idempotent)
for (const col of [
  "buy_price_usd REAL",
  "sale_price_usd REAL",
  "sale_date TEXT",
  "actual_fees_usd REAL",
  "potential_profit_usd REAL",
  "potential_margin_pct REAL",
]) {
  try { sqlite.exec(`ALTER TABLE opportunities ADD COLUMN ${col}`); } catch {}
}

// Product type description column (idempotent)
try { sqlite.exec(`ALTER TABLE product_types ADD COLUMN description TEXT`); } catch {}

// Products.metadata column (idempotent)
try { sqlite.exec(`ALTER TABLE products ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'`); } catch {}

// Price points dimensions column + data migration (idempotent)
try {
  sqlite.exec(`ALTER TABLE price_points ADD COLUMN dimensions TEXT NOT NULL DEFAULT '{}'`);
  // First time: hydrate from legacy condition column
  sqlite.exec(`
    UPDATE price_points
       SET dimensions = json_object('condition', condition)
     WHERE dimensions = '{}' AND condition IS NOT NULL AND condition != ''
  `);
} catch {}

// New product_type_fields table (idempotent)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS product_type_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_type_id TEXT NOT NULL REFERENCES product_types(id),
    key TEXT NOT NULL,
    label TEXT NOT NULL,
    data_type TEXT NOT NULL,
    pattern TEXT,
    min_value REAL,
    max_value REAL,
    is_integer INTEGER NOT NULL DEFAULT 0,
    format TEXT,
    unit TEXT,
    extract_hint TEXT,
    is_required INTEGER NOT NULL DEFAULT 0,
    is_searchable INTEGER NOT NULL DEFAULT 0,
    search_weight REAL NOT NULL DEFAULT 1.0,
    is_identifier INTEGER NOT NULL DEFAULT 0,
    is_pricing_axis INTEGER NOT NULL DEFAULT 0,
    display_priority INTEGER NOT NULL DEFAULT 100,
    is_hidden INTEGER NOT NULL DEFAULT 0
  )
`);
sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_product_type_field_key ON product_type_fields(product_type_id, key)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS ix_pricing_axis ON product_type_fields(is_pricing_axis)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS ix_identifier ON product_type_fields(is_identifier)`);
sqlite.exec(`CREATE INDEX IF NOT EXISTS ix_searchable ON product_type_fields(is_searchable)`);

// New product_type_field_enum_values table (idempotent)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS product_type_field_enum_values (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    field_id INTEGER NOT NULL REFERENCES product_type_fields(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT,
    display_order INTEGER NOT NULL DEFAULT 100
  )
`);
sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_field_enum_value ON product_type_field_enum_values(field_id, value)`);

// Add unique indexes (idempotent)
try { sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_opportunities_listing_product ON opportunities(listing_id, product_id)`); } catch {}
try { sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_listing_items ON listing_items(listing_id, product_id)`); } catch {}

export const db = drizzle(sqlite, { schema });
export { sqlite };
