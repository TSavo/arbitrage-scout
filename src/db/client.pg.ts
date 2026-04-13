import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "./schema.pg";
import { log } from "@/lib/logger";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required for the postgres client");
}

log("db/client.pg", `connecting to ${DATABASE_URL.replace(/:[^:@]+@/, ":***@")}`);

// postgres-js client — use a modest pool by default; scan workers can
// override via PG_MAX.
const sql = postgres(DATABASE_URL, {
  max: Number(process.env.PG_MAX ?? 10),
  prepare: true,
});

// ── Idempotent bootstrap ─────────────────────────────────────────────
// Mirrors src/db/client.ts but for pg. We execute synchronously at
// import-time via a top-level await block; pg DDL is transactional and
// cheap so this is fine for a process-local startup.

async function bootstrap() {
  await sql.unsafe(`CREATE EXTENSION IF NOT EXISTS vector`);

  // ── Taxonomy ─────────────────────────────────────────────────────
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS taxonomy_nodes (
      id SERIAL PRIMARY KEY,
      parent_id INTEGER REFERENCES taxonomy_nodes(id),
      slug TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      gpt_id TEXT,
      path_cache TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      canonical BOOLEAN NOT NULL DEFAULT FALSE,
      observation_count INTEGER NOT NULL DEFAULT 0,
      last_observed_at TEXT
    )
  `);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_taxonomy_parent_slug ON taxonomy_nodes(parent_id, slug)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_taxonomy_parent ON taxonomy_nodes(parent_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_taxonomy_path ON taxonomy_nodes(path_cache)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_taxonomy_canonical ON taxonomy_nodes(canonical)`);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS taxonomy_node_fields (
      id SERIAL PRIMARY KEY,
      node_id INTEGER NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      label TEXT NOT NULL,
      data_type TEXT NOT NULL,
      pattern TEXT,
      min_value REAL,
      max_value REAL,
      is_integer BOOLEAN NOT NULL DEFAULT FALSE,
      format TEXT,
      unit TEXT,
      extract_hint TEXT,
      is_required BOOLEAN NOT NULL DEFAULT FALSE,
      is_searchable BOOLEAN NOT NULL DEFAULT FALSE,
      search_weight REAL NOT NULL DEFAULT 1.0,
      is_identifier BOOLEAN NOT NULL DEFAULT FALSE,
      is_pricing_axis BOOLEAN NOT NULL DEFAULT FALSE,
      display_priority INTEGER NOT NULL DEFAULT 100,
      is_hidden BOOLEAN NOT NULL DEFAULT FALSE,
      canonical BOOLEAN NOT NULL DEFAULT FALSE,
      observation_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    )
  `);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_taxonomy_node_field_key ON taxonomy_node_fields(node_id, key)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_taxonomy_node_field_node ON taxonomy_node_fields(node_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_taxonomy_node_field_pricing_axis ON taxonomy_node_fields(is_pricing_axis)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_taxonomy_node_field_identifier ON taxonomy_node_fields(is_identifier)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_taxonomy_node_field_searchable ON taxonomy_node_fields(is_searchable)`);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS taxonomy_node_field_enum_values (
      id SERIAL PRIMARY KEY,
      field_id INTEGER NOT NULL REFERENCES taxonomy_node_fields(id) ON DELETE CASCADE,
      value TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      display_order INTEGER NOT NULL DEFAULT 100
    )
  `);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_taxonomy_field_enum_value ON taxonomy_node_field_enum_values(field_id, value)`);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS taxonomy_external_refs (
      id SERIAL PRIMARY KEY,
      node_id INTEGER NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      external_id TEXT NOT NULL,
      external_path TEXT,
      confidence REAL NOT NULL DEFAULT 1.0,
      created_at TEXT NOT NULL
    )
  `);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_taxonomy_external_refs ON taxonomy_external_refs(node_id, source)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_taxonomy_external_refs_lookup ON taxonomy_external_refs(source, external_id)`);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      id SERIAL PRIMARY KEY,
      event_type TEXT NOT NULL,
      node_id INTEGER,
      field_id INTEGER,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      triggered_by TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_schema_versions_created ON schema_versions(created_at)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_schema_versions_node ON schema_versions(node_id)`);

  // ── Products ─────────────────────────────────────────────────────
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS products (
      id TEXT PRIMARY KEY,
      taxonomy_node_id INTEGER,
      extracted_schema_version INTEGER,
      title TEXT NOT NULL,
      platform TEXT,
      release_date TEXT,
      genre TEXT,
      sales_volume INTEGER NOT NULL DEFAULT 0,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_products_taxonomy_node ON products(taxonomy_node_id)`);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS product_identifiers (
      id SERIAL PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      identifier_type TEXT NOT NULL,
      identifier_value TEXT NOT NULL
    )
  `);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_identifiers ON product_identifiers(product_id, identifier_type, identifier_value)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_identifiers_lookup ON product_identifiers(identifier_type, identifier_value)`);

  // ── Price Points ─────────────────────────────────────────────────
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS price_points (
      id SERIAL PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      source TEXT NOT NULL,
      condition TEXT NOT NULL DEFAULT '',
      dimensions JSONB NOT NULL DEFAULT '{}'::jsonb,
      price_usd REAL NOT NULL,
      recorded_at TEXT NOT NULL
    )
  `);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_price_points ON price_points(product_id, source, condition, recorded_at)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_price_points_product_date ON price_points(product_id, recorded_at)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_price_points_latest ON price_points(product_id, source, condition)`);

  // ── Marketplaces / Listings ──────────────────────────────────────
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS marketplaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      base_url TEXT NOT NULL DEFAULT '',
      supports_api BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS listings (
      id SERIAL PRIMARY KEY,
      marketplace_id TEXT NOT NULL REFERENCES marketplaces(id),
      marketplace_listing_id TEXT NOT NULL,
      url TEXT,
      title TEXT NOT NULL,
      description TEXT,
      price_usd REAL NOT NULL,
      shipping_usd REAL NOT NULL DEFAULT 0,
      seller TEXT,
      is_lot BOOLEAN NOT NULL DEFAULT FALSE,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      end_time TEXT
    )
  `);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_listings ON listings(marketplace_id, marketplace_listing_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_listings_active ON listings(marketplace_id, is_active)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_listings_end_time ON listings(end_time)`);

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS listing_items (
      id SERIAL PRIMARY KEY,
      listing_id INTEGER NOT NULL REFERENCES listings(id),
      product_id TEXT NOT NULL REFERENCES products(id),
      quantity INTEGER NOT NULL DEFAULT 1,
      condition TEXT NOT NULL DEFAULT 'loose',
      condition_details JSONB NOT NULL DEFAULT '{}'::jsonb,
      estimated_value_usd REAL,
      confidence REAL NOT NULL DEFAULT 0,
      confirmed BOOLEAN NOT NULL DEFAULT FALSE,
      raw_extraction JSONB DEFAULT '{}'::jsonb
    )
  `);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_listing_items_listing ON listing_items(listing_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_listing_items_product ON listing_items(product_id)`);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_listing_items ON listing_items(listing_id, product_id)`);

  // ── Opportunities ────────────────────────────────────────────────
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS opportunities (
      id SERIAL PRIMARY KEY,
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
      flags JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'new',
      found_at TEXT NOT NULL,
      reviewed_at TEXT,
      notes TEXT,
      buy_price_usd REAL,
      sale_price_usd REAL,
      sale_date TEXT,
      actual_fees_usd REAL,
      potential_profit_usd REAL,
      potential_margin_pct REAL
    )
  `);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_opportunities_status ON opportunities(status, found_at)`);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_opportunities_listing_product ON opportunities(listing_id, product_id)`);

  // ── Inventory ────────────────────────────────────────────────────
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS inventory_items (
      id SERIAL PRIMARY KEY,
      product_id TEXT REFERENCES products(id),
      source TEXT NOT NULL,
      source_sku TEXT,
      source_order_id TEXT,
      title TEXT NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 1,
      purchase_price_usd REAL,
      purchase_date TEXT,
      imported_at TEXT NOT NULL
    )
  `);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_inventory_source_order_sku ON inventory_items(source, source_order_id, source_sku)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_inventory_product ON inventory_items(product_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_inventory_source_sku ON inventory_items(source, source_sku)`);

  // ── Watchlist ────────────────────────────────────────────────────
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS watchlist_items (
      id SERIAL PRIMARY KEY,
      product_id TEXT NOT NULL REFERENCES products(id),
      target_price_pct REAL NOT NULL,
      condition TEXT NOT NULL DEFAULT 'loose',
      created_at TEXT NOT NULL,
      triggered_at TEXT,
      active BOOLEAN NOT NULL DEFAULT TRUE,
      notes TEXT
    )
  `);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_watchlist_active ON watchlist_items(active, product_id)`);

  // ── Embeddings (metadata) ────────────────────────────────────────
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS embeddings (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      embedded_at TEXT NOT NULL
    )
  `);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_embeddings_entity ON embeddings(entity_type, entity_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_embeddings_type ON embeddings(entity_type)`);

  // ── pgvector: replaces sqlite-vec vec_embeddings virtual table ───
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS vec_embeddings (
      id SERIAL PRIMARY KEY,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      embedding vector(4096) NOT NULL
    )
  `);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_vec_embeddings_entity ON vec_embeddings(entity_type, entity_id)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_vec_embeddings_type ON vec_embeddings(entity_type)`);
  // Note: an HNSW or IVFFlat index on `embedding` is recommended for large
  // corpora, but requires choosing an opclass (vector_cosine_ops, etc.)
  // and data-loaded training for IVFFlat. Defer to cutover.

  // ── HTTP Cache ───────────────────────────────────────────────────
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS http_cache (
      id SERIAL PRIMARY KEY,
      fingerprint TEXT NOT NULL,
      method TEXT NOT NULL,
      url TEXT NOT NULL,
      body_hash TEXT NOT NULL,
      status INTEGER NOT NULL,
      response_body TEXT NOT NULL,
      content_type TEXT,
      fetched_at TEXT NOT NULL,
      expires_at TEXT,
      hits INTEGER NOT NULL DEFAULT 0
    )
  `);
  await sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS uq_http_cache_fp ON http_cache(fingerprint)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_http_cache_url ON http_cache(url)`);
  await sql.unsafe(`CREATE INDEX IF NOT EXISTS ix_http_cache_expires ON http_cache(expires_at)`);

  // ── Scan Logs ────────────────────────────────────────────────────
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS scan_logs (
      id SERIAL PRIMARY KEY,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      marketplace_id TEXT REFERENCES marketplaces(id),
      queries_run INTEGER NOT NULL DEFAULT 0,
      listings_found INTEGER NOT NULL DEFAULT 0,
      opportunities_found INTEGER NOT NULL DEFAULT 0,
      rate_limited BOOLEAN NOT NULL DEFAULT FALSE,
      error TEXT
    )
  `);

  log("db/client.pg", "bootstrap complete");
}

/** The bootstrap promise — await this before first query to ensure DDL is applied. */
export const pgReady: Promise<void> = bootstrap();

export const db = drizzle(sql, { schema });
export { sql };
