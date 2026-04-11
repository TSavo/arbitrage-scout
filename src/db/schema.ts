import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// ── Product Types ────────────────────────────────────────────────────

export const productTypes = sqliteTable("product_types", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  conditionSchema: text("condition_schema", { mode: "json" })
    .notNull()
    .$type<string[]>()
    .default([]),
  metadataSchema: text("metadata_schema", { mode: "json" })
    .notNull()
    .$type<string[]>()
    .default([]),
});

// ── Products ─────────────────────────────────────────────────────────

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    productTypeId: text("product_type_id")
      .notNull()
      .references(() => productTypes.id),
    title: text("title").notNull(),
    platform: text("platform"),
    releaseDate: text("release_date"),
    genre: text("genre"),
    salesVolume: integer("sales_volume").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("ix_products_type_volume").on(table.productTypeId, table.salesVolume),
  ],
);

// ── Product Identifiers ──────────────────────────────────────────────

export const productIdentifiers = sqliteTable(
  "product_identifiers",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    identifierType: text("identifier_type").notNull(),
    identifierValue: text("identifier_value").notNull(),
  },
  (table) => [
    uniqueIndex("uq_identifiers").on(
      table.productId,
      table.identifierType,
      table.identifierValue,
    ),
    index("ix_identifiers_lookup").on(
      table.identifierType,
      table.identifierValue,
    ),
  ],
);

// ── Price Points ─────────────────────────────────────────────────────

export const pricePoints = sqliteTable(
  "price_points",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    source: text("source").notNull(),
    condition: text("condition").notNull(),
    priceUsd: real("price_usd").notNull(),
    recordedAt: text("recorded_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_price_points").on(
      table.productId,
      table.source,
      table.condition,
      table.recordedAt,
    ),
    index("ix_price_points_product_date").on(
      table.productId,
      table.recordedAt,
    ),
    index("ix_price_points_latest").on(
      table.productId,
      table.source,
      table.condition,
    ),
  ],
);

// ── Marketplaces ─────────────────────────────────────────────────────

export const marketplaces = sqliteTable("marketplaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull().default(""),
  supportsApi: integer("supports_api", { mode: "boolean" })
    .notNull()
    .default(false),
});

// ── Listings ─────────────────────────────────────────────────────────

export const listings = sqliteTable(
  "listings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    marketplaceId: text("marketplace_id")
      .notNull()
      .references(() => marketplaces.id),
    marketplaceListingId: text("marketplace_listing_id").notNull(),
    url: text("url"),
    title: text("title").notNull(),
    description: text("description"),
    priceUsd: real("price_usd").notNull(),
    shippingUsd: real("shipping_usd").notNull().default(0),
    seller: text("seller"),
    isLot: integer("is_lot", { mode: "boolean" }).notNull().default(false),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    isActive: integer("is_active", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [
    uniqueIndex("uq_listings").on(
      table.marketplaceId,
      table.marketplaceListingId,
    ),
    index("ix_listings_active").on(table.marketplaceId, table.isActive),
  ],
);

// ── Listing Items ────────────────────────────────────────────────────

export const listingItems = sqliteTable(
  "listing_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    listingId: integer("listing_id")
      .notNull()
      .references(() => listings.id),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    quantity: integer("quantity").notNull().default(1),
    condition: text("condition").notNull().default("loose"),
    conditionDetails: text("condition_details", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    estimatedValueUsd: real("estimated_value_usd"),
    confidence: real("confidence").notNull().default(0),
    confirmed: integer("confirmed", { mode: "boolean" }).notNull().default(false),
    rawExtraction: text("raw_extraction", { mode: "json" })
      .$type<Record<string, unknown>>()
      .default({}),
  },
  (table) => [
    index("ix_listing_items_listing").on(table.listingId),
    index("ix_listing_items_product").on(table.productId),
    uniqueIndex("uq_listing_items").on(table.listingId, table.productId),
  ],
);

// ── Opportunities ────────────────────────────────────────────────────

export const opportunities = sqliteTable(
  "opportunities",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    listingId: integer("listing_id")
      .notNull()
      .references(() => listings.id),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    listingPriceUsd: real("listing_price_usd").notNull(),
    marketPriceUsd: real("market_price_usd").notNull(),
    marketPriceSource: text("market_price_source").notNull(),
    marketPriceCondition: text("market_price_condition").notNull(),
    profitUsd: real("profit_usd").notNull(),
    marginPct: real("margin_pct").notNull(),
    feesUsd: real("fees_usd").notNull().default(0),
    confidence: real("confidence").notNull().default(0),
    flags: text("flags", { mode: "json" })
      .notNull()
      .$type<string[]>()
      .default([]),
    status: text("status").notNull().default("new"),
    foundAt: text("found_at").notNull(),
    reviewedAt: text("reviewed_at"),
    notes: text("notes"),
    buyPriceUsd: real("buy_price_usd"),
    salePriceUsd: real("sale_price_usd"),
    saleDate: text("sale_date"),
    actualFeesUsd: real("actual_fees_usd"),
    potentialProfitUsd: real("potential_profit_usd"),
    potentialMarginPct: real("potential_margin_pct"),
  },
  (table) => [
    index("ix_opportunities_status").on(table.status, table.foundAt),
    uniqueIndex("uq_opportunities_listing_product").on(table.listingId, table.productId),
  ],
);

// ── Watchlist Items ─────────────────────────────────────────────────

export const watchlistItems = sqliteTable(
  "watchlist_items",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productId: text("product_id")
      .notNull()
      .references(() => products.id),
    targetPricePct: real("target_price_pct").notNull(), // e.g. 20 = alert when 20% below market
    condition: text("condition").notNull().default("loose"),
    createdAt: text("created_at").notNull(),
    triggeredAt: text("triggered_at"),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    notes: text("notes"),
  },
  (table) => [
    index("ix_watchlist_active").on(table.active, table.productId),
  ],
);

// ── Embeddings (polymorphic) ─────────────────────────────────────────

export const embeddings = sqliteTable(
  "embeddings",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    entityType: text("entity_type").notNull(), // "product" | "listing" | etc
    entityId: text("entity_id").notNull(),
    embeddedAt: text("embedded_at").notNull(),
    // Vector data lives in sqlite-vec virtual table (vec_embeddings), not here.
  },
  (table) => [
    uniqueIndex("uq_embeddings_entity").on(table.entityType, table.entityId),
    index("ix_embeddings_type").on(table.entityType),
  ],
);

// ── Scan Logs ────────────────────────────────────────────────────────

export const scanLogs = sqliteTable("scan_logs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  startedAt: text("started_at").notNull(),
  finishedAt: text("finished_at"),
  marketplaceId: text("marketplace_id").references(() => marketplaces.id),
  queriesRun: integer("queries_run").notNull().default(0),
  listingsFound: integer("listings_found").notNull().default(0),
  opportunitiesFound: integer("opportunities_found").notNull().default(0),
  rateLimited: integer("rate_limited", { mode: "boolean" })
    .notNull()
    .default(false),
  error: text("error"),
});
