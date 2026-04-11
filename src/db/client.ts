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

// Add unique indexes (idempotent)
try { sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_opportunities_listing_product ON opportunities(listing_id, product_id)`); } catch {}
try { sqlite.exec(`CREATE UNIQUE INDEX IF NOT EXISTS uq_listing_items ON listing_items(listing_id, product_id)`); } catch {}

export const db = drizzle(sqlite, { schema });
export { sqlite };
