/**
 * Test helpers — in-memory SQLite DB with schema for isolated tests.
 */

import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
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
      description TEXT,
      condition_schema TEXT NOT NULL DEFAULT '[]',
      metadata_schema TEXT NOT NULL DEFAULT '[]'
    )
  `);

  sqlite.exec(`
    CREATE TABLE product_type_fields (
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
      is_hidden INTEGER NOT NULL DEFAULT 0,
      UNIQUE(product_type_id, key)
    )
  `);

  sqlite.exec(`
    CREATE TABLE product_type_field_enum_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_id INTEGER NOT NULL REFERENCES product_type_fields(id) ON DELETE CASCADE,
      value TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      display_order INTEGER NOT NULL DEFAULT 100,
      UNIQUE(field_id, value)
    )
  `);

  sqlite.exec(`
    CREATE TABLE products (
      id TEXT PRIMARY KEY,
      product_type_id TEXT NOT NULL REFERENCES product_types(id),
      taxonomy_node_id INTEGER,
      extracted_schema_version INTEGER,
      title TEXT NOT NULL,
      platform TEXT,
      release_date TEXT,
      genre TEXT,
      sales_volume INTEGER NOT NULL DEFAULT 0,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  sqlite.exec(`
    CREATE TABLE taxonomy_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_id INTEGER REFERENCES taxonomy_nodes(id),
      slug TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      gpt_id TEXT,
      path_cache TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      canonical INTEGER NOT NULL DEFAULT 0,
      observation_count INTEGER NOT NULL DEFAULT 0,
      last_observed_at TEXT,
      UNIQUE(parent_id, slug)
    )
  `);

  sqlite.exec(`
    CREATE TABLE taxonomy_node_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
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
      is_hidden INTEGER NOT NULL DEFAULT 0,
      canonical INTEGER NOT NULL DEFAULT 0,
      observation_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      UNIQUE(node_id, key)
    )
  `);

  sqlite.exec(`
    CREATE TABLE taxonomy_node_field_enum_values (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      field_id INTEGER NOT NULL REFERENCES taxonomy_node_fields(id) ON DELETE CASCADE,
      value TEXT NOT NULL,
      label TEXT NOT NULL,
      description TEXT,
      display_order INTEGER NOT NULL DEFAULT 100,
      UNIQUE(field_id, value)
    )
  `);

  sqlite.exec(`
    CREATE TABLE schema_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      node_id INTEGER,
      field_id INTEGER,
      payload TEXT NOT NULL DEFAULT '{}',
      triggered_by TEXT NOT NULL,
      created_at TEXT NOT NULL
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
      condition TEXT NOT NULL DEFAULT '',
      dimensions TEXT NOT NULL DEFAULT '{}',
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

  // Taxonomy root — required by TaxonomyRepo.getRoot() used in the pipeline.
  db.insert(schema.taxonomyNodes).values({
    slug: "root",
    label: "Root",
    description: "Taxonomy root",
    pathCache: "/",
    canonical: true,
    observationCount: 0,
    createdAt: now,
    createdBy: "test-seed",
  }).run();

  // Product types (legacy conditionSchema/metadataSchema left empty — the
  // DB-driven schema comes from product_type_fields).
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

  db.insert(schema.productTypes).values({
    id: "bourbon",
    name: "Bourbon",
    conditionSchema: [],
    metadataSchema: [],
  }).run();

  db.insert(schema.productTypes).values({
    id: "sports_card",
    name: "Sports Card",
    conditionSchema: [],
    metadataSchema: [],
  }).run();

  // Generic fallback product type used when the new taxonomy-driven pipeline
  // creates a product but has no legacy product_type mapping.
  db.insert(schema.productTypes).values({
    id: "generic",
    name: "Generic",
    conditionSchema: [],
    metadataSchema: [],
  }).run();

  // Product type fields (DB-driven schema)
  const retroCondition = db.insert(schema.productTypeFields).values({
    productTypeId: "retro_game", key: "condition", label: "Condition",
    dataType: "string", isPricingAxis: true, isSearchable: false,
    searchWeight: 1, isIdentifier: false, isRequired: false,
    isInteger: false, displayPriority: 5, isHidden: false,
  }).returning({ id: schema.productTypeFields.id }).get();

  for (const [i, v] of ["loose", "cib", "new_sealed"].entries()) {
    db.insert(schema.productTypeFieldEnumValues).values({
      fieldId: retroCondition.id, value: v, label: v, displayOrder: (i + 1) * 10,
    }).run();
  }

  db.insert(schema.productTypeFields).values({
    productTypeId: "retro_game", key: "platform", label: "Platform",
    dataType: "string", isPricingAxis: false, isSearchable: true,
    searchWeight: 2, isIdentifier: false, isRequired: false,
    isInteger: false, displayPriority: 20, isHidden: false,
  }).run();

  const pokeCondition = db.insert(schema.productTypeFields).values({
    productTypeId: "pokemon_card", key: "condition", label: "Condition",
    dataType: "string", isPricingAxis: true, isSearchable: false,
    searchWeight: 1, isIdentifier: false, isRequired: false,
    isInteger: false, displayPriority: 5, isHidden: false,
  }).returning({ id: schema.productTypeFields.id }).get();
  for (const [i, v] of ["loose", "graded"].entries()) {
    db.insert(schema.productTypeFieldEnumValues).values({
      fieldId: pokeCondition.id, value: v, label: v, displayOrder: (i + 1) * 10,
    }).run();
  }
  db.insert(schema.productTypeFields).values({
    productTypeId: "pokemon_card", key: "set_name", label: "Set",
    dataType: "string", isPricingAxis: false, isSearchable: true,
    searchWeight: 3, isIdentifier: true, isRequired: false,
    isInteger: false, displayPriority: 10, isHidden: false,
  }).run();
  db.insert(schema.productTypeFields).values({
    productTypeId: "pokemon_card", key: "card_number", label: "Card #",
    dataType: "string", isPricingAxis: false, isSearchable: true,
    searchWeight: 3, isIdentifier: true, isRequired: false,
    isInteger: false, displayPriority: 20, isHidden: false,
  }).run();

  // Bourbon: no pricing axes, just descriptive fields
  db.insert(schema.productTypeFields).values({
    productTypeId: "bourbon", key: "distillery", label: "Distillery",
    dataType: "string", isPricingAxis: false, isSearchable: true,
    searchWeight: 3, isIdentifier: false, isRequired: true,
    isInteger: false, displayPriority: 10, isHidden: false,
  }).run();
  db.insert(schema.productTypeFields).values({
    productTypeId: "bourbon", key: "age", label: "Age",
    dataType: "number", isPricingAxis: false, isSearchable: false,
    searchWeight: 1, isIdentifier: false, isRequired: false,
    isInteger: true, displayPriority: 20, isHidden: false,
  }).run();

  // Sports card: multi-axis pricing (condition + grade + grading_company)
  const sportsCondition = db.insert(schema.productTypeFields).values({
    productTypeId: "sports_card", key: "condition", label: "Condition",
    dataType: "string", isPricingAxis: true, isSearchable: false,
    searchWeight: 1, isIdentifier: false, isRequired: false,
    isInteger: false, displayPriority: 5, isHidden: false,
  }).returning({ id: schema.productTypeFields.id }).get();
  for (const [i, v] of ["raw", "graded"].entries()) {
    db.insert(schema.productTypeFieldEnumValues).values({
      fieldId: sportsCondition.id, value: v, label: v, displayOrder: (i + 1) * 10,
    }).run();
  }
  db.insert(schema.productTypeFields).values({
    productTypeId: "sports_card", key: "grade", label: "Grade",
    dataType: "number", isPricingAxis: true, isSearchable: false,
    searchWeight: 1, isIdentifier: false, isRequired: false,
    isInteger: false, minValue: 1, maxValue: 10,
    displayPriority: 6, isHidden: false,
  }).run();
  db.insert(schema.productTypeFields).values({
    productTypeId: "sports_card", key: "grading_company", label: "Grading company",
    dataType: "string", isPricingAxis: true, isSearchable: false,
    searchWeight: 1, isIdentifier: false, isRequired: false,
    isInteger: false, displayPriority: 7, isHidden: false,
  }).run();
  db.insert(schema.productTypeFields).values({
    productTypeId: "sports_card", key: "player", label: "Player",
    dataType: "string", isPricingAxis: false, isSearchable: true,
    searchWeight: 3, isIdentifier: false, isRequired: true,
    isInteger: false, displayPriority: 10, isHidden: false,
  }).run();

  // Marketplaces
  db.insert(schema.marketplaces).values({ id: "shopgoodwill", name: "ShopGoodwill", baseUrl: "https://shopgoodwill.com", supportsApi: true }).run();
  db.insert(schema.marketplaces).values({ id: "hibid", name: "HiBid", baseUrl: "https://hibid.com", supportsApi: true }).run();
  db.insert(schema.marketplaces).values({ id: "ebay", name: "eBay", baseUrl: "https://ebay.com", supportsApi: true }).run();
  db.insert(schema.marketplaces).values({ id: "pricecharting", name: "PriceCharting", baseUrl: "https://pricecharting.com", supportsApi: true }).run();

  // Minimal taxonomy leaf: retro_game under the root that was inserted above.
  const rootNode = db.select().from(schema.taxonomyNodes).where(eq(schema.taxonomyNodes.slug, "root")).get();
  const retroNode = db.insert(schema.taxonomyNodes).values({
    parentId: rootNode!.id, slug: "retro_game", label: "Retro Video Game",
    pathCache: "/retro_game", canonical: true, observationCount: 0,
    createdAt: now, createdBy: "seed",
  }).returning({ id: schema.taxonomyNodes.id }).get();

  const cond = db.insert(schema.taxonomyNodeFields).values({
    nodeId: retroNode.id, key: "condition", label: "Condition",
    dataType: "string", isPricingAxis: true, isSearchable: false,
    searchWeight: 1, isIdentifier: false, isRequired: false, isInteger: false,
    displayPriority: 5, isHidden: false, canonical: true, observationCount: 0,
    createdAt: now, createdBy: "seed",
  }).returning({ id: schema.taxonomyNodeFields.id }).get();
  for (const [i, v] of ["loose", "cib", "new_sealed"].entries()) {
    db.insert(schema.taxonomyNodeFieldEnumValues).values({
      fieldId: cond.id, value: v, label: v, displayOrder: (i + 1) * 10,
    }).run();
  }

  // Products — include taxonomyNodeId so tier-1/tier-2 paths can resolve the node.
  db.insert(schema.products).values({
    id: "pc-1", productTypeId: "retro_game", taxonomyNodeId: retroNode.id,
    title: "Super Mario 64",
    platform: "Nintendo 64", salesVolume: 5000, createdAt: now, updatedAt: now,
  }).run();

  db.insert(schema.products).values({
    id: "pc-2", productTypeId: "retro_game", taxonomyNodeId: retroNode.id,
    title: "GoldenEye 007",
    platform: "Nintendo 64", salesVolume: 3000, createdAt: now, updatedAt: now,
  }).run();

  db.insert(schema.products).values({
    id: "pc-3", productTypeId: "pokemon_card", title: "Charizard VMAX",
    platform: "Pokemon Darkness Ablaze", salesVolume: 8000, createdAt: now, updatedAt: now,
  }).run();

  db.insert(schema.products).values({
    id: "pc-bourbon-1", productTypeId: "bourbon", title: "Pappy Van Winkle 23",
    salesVolume: 100, createdAt: now, updatedAt: now,
  }).run();

  db.insert(schema.products).values({
    id: "pc-sports-1", productTypeId: "sports_card", title: "Mickey Mantle 1952 Topps",
    salesVolume: 500, createdAt: now, updatedAt: now,
  }).run();

  // Price points — with dimensions JSON populated
  db.insert(schema.pricePoints).values({ productId: "pc-1", source: "pricecharting", condition: "loose", dimensions: { condition: "loose" }, priceUsd: 25.00, recordedAt: "2026-04-10" }).run();
  db.insert(schema.pricePoints).values({ productId: "pc-1", source: "pricecharting", condition: "cib", dimensions: { condition: "cib" }, priceUsd: 45.00, recordedAt: "2026-04-10" }).run();
  db.insert(schema.pricePoints).values({ productId: "pc-2", source: "pricecharting", condition: "loose", dimensions: { condition: "loose" }, priceUsd: 15.00, recordedAt: "2026-04-10" }).run();
  db.insert(schema.pricePoints).values({ productId: "pc-3", source: "pricecharting", condition: "loose", dimensions: { condition: "loose" }, priceUsd: 150.00, recordedAt: "2026-04-10" }).run();
  // Bourbon: single price, no pricing axes
  db.insert(schema.pricePoints).values({ productId: "pc-bourbon-1", source: "secondary", condition: "", dimensions: {}, priceUsd: 3500.00, recordedAt: "2026-04-10" }).run();
  // Sports card: multiple combos
  db.insert(schema.pricePoints).values({ productId: "pc-sports-1", source: "ebay", condition: "raw", dimensions: { condition: "raw" }, priceUsd: 200.00, recordedAt: "2026-04-10" }).run();
  db.insert(schema.pricePoints).values({ productId: "pc-sports-1", source: "ebay", condition: "graded", dimensions: { condition: "graded", grade: 8, grading_company: "PSA" }, priceUsd: 5000.00, recordedAt: "2026-04-10" }).run();
  db.insert(schema.pricePoints).values({ productId: "pc-sports-1", source: "ebay", condition: "graded", dimensions: { condition: "graded", grade: 9, grading_company: "PSA" }, priceUsd: 25000.00, recordedAt: "2026-04-11" }).run();

  return { now };
}
