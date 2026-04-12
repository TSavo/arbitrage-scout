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
  description: text("description"),
  /** @deprecated — superseded by product_type_fields + is_pricing_axis / enum values. */
  conditionSchema: text("condition_schema", { mode: "json" })
    .notNull()
    .$type<string[]>()
    .default([]),
  /** @deprecated — superseded by product_type_fields. */
  metadataSchema: text("metadata_schema", { mode: "json" })
    .notNull()
    .$type<string[]>()
    .default([]),
});

// ── Product Type Fields (DB-driven schema) ───────────────────────────

export const productTypeFields = sqliteTable(
  "product_type_fields",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    productTypeId: text("product_type_id")
      .notNull()
      .references(() => productTypes.id),
    key: text("key").notNull(),
    label: text("label").notNull(),
    dataType: text("data_type").notNull(), // "string" | "number" | "boolean"

    pattern: text("pattern"),
    minValue: real("min_value"),
    maxValue: real("max_value"),
    isInteger: integer("is_integer", { mode: "boolean" }).notNull().default(false),

    format: text("format"),
    unit: text("unit"),
    extractHint: text("extract_hint"),

    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(false),
    isSearchable: integer("is_searchable", { mode: "boolean" }).notNull().default(false),
    searchWeight: real("search_weight").notNull().default(1.0),
    isIdentifier: integer("is_identifier", { mode: "boolean" }).notNull().default(false),
    isPricingAxis: integer("is_pricing_axis", { mode: "boolean" }).notNull().default(false),
    displayPriority: integer("display_priority").notNull().default(100),
    isHidden: integer("is_hidden", { mode: "boolean" }).notNull().default(false),
  },
  (t) => [
    uniqueIndex("uq_product_type_field_key").on(t.productTypeId, t.key),
    index("ix_pricing_axis").on(t.isPricingAxis),
    index("ix_identifier").on(t.isIdentifier),
    index("ix_searchable").on(t.isSearchable),
  ],
);

export const productTypeFieldEnumValues = sqliteTable(
  "product_type_field_enum_values",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fieldId: integer("field_id")
      .notNull()
      .references(() => productTypeFields.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    displayOrder: integer("display_order").notNull().default(100),
  },
  (t) => [uniqueIndex("uq_field_enum_value").on(t.fieldId, t.value)],
);

// ── Taxonomy (DB-driven hierarchical product tree) ───────────────────

export const taxonomyNodes = sqliteTable(
  "taxonomy_nodes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    parentId: integer("parent_id"),
    slug: text("slug").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    gptId: text("gpt_id"),
    pathCache: text("path_cache").notNull(),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
    canonical: integer("canonical", { mode: "boolean" }).notNull().default(false),
    observationCount: integer("observation_count").notNull().default(0),
    lastObservedAt: text("last_observed_at"),
  },
  (t) => [
    uniqueIndex("uq_taxonomy_parent_slug").on(t.parentId, t.slug),
    index("ix_taxonomy_parent").on(t.parentId),
    index("ix_taxonomy_path").on(t.pathCache),
    index("ix_taxonomy_canonical").on(t.canonical),
  ],
);

export const taxonomyNodeFields = sqliteTable(
  "taxonomy_node_fields",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    nodeId: integer("node_id")
      .notNull()
      .references(() => taxonomyNodes.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    dataType: text("data_type").notNull(),
    pattern: text("pattern"),
    minValue: real("min_value"),
    maxValue: real("max_value"),
    isInteger: integer("is_integer", { mode: "boolean" }).notNull().default(false),
    format: text("format"),
    unit: text("unit"),
    extractHint: text("extract_hint"),
    isRequired: integer("is_required", { mode: "boolean" }).notNull().default(false),
    isSearchable: integer("is_searchable", { mode: "boolean" }).notNull().default(false),
    searchWeight: real("search_weight").notNull().default(1.0),
    isIdentifier: integer("is_identifier", { mode: "boolean" }).notNull().default(false),
    isPricingAxis: integer("is_pricing_axis", { mode: "boolean" }).notNull().default(false),
    displayPriority: integer("display_priority").notNull().default(100),
    isHidden: integer("is_hidden", { mode: "boolean" }).notNull().default(false),
    canonical: integer("canonical", { mode: "boolean" }).notNull().default(false),
    observationCount: integer("observation_count").notNull().default(0),
    createdAt: text("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (t) => [
    uniqueIndex("uq_taxonomy_node_field_key").on(t.nodeId, t.key),
    index("ix_taxonomy_node_field_node").on(t.nodeId),
    index("ix_taxonomy_node_field_pricing_axis").on(t.isPricingAxis),
    index("ix_taxonomy_node_field_identifier").on(t.isIdentifier),
    index("ix_taxonomy_node_field_searchable").on(t.isSearchable),
  ],
);

export const taxonomyNodeFieldEnumValues = sqliteTable(
  "taxonomy_node_field_enum_values",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    fieldId: integer("field_id")
      .notNull()
      .references(() => taxonomyNodeFields.id, { onDelete: "cascade" }),
    value: text("value").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    displayOrder: integer("display_order").notNull().default(100),
  },
  (t) => [uniqueIndex("uq_taxonomy_field_enum_value").on(t.fieldId, t.value)],
);

export const schemaVersions = sqliteTable(
  "schema_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventType: text("event_type").notNull(),
    nodeId: integer("node_id"),
    fieldId: integer("field_id"),
    payload: text("payload", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    triggeredBy: text("triggered_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("ix_schema_versions_created").on(t.createdAt),
    index("ix_schema_versions_node").on(t.nodeId),
  ],
);

// ── Products ─────────────────────────────────────────────────────────

export const products = sqliteTable(
  "products",
  {
    id: text("id").primaryKey(),
    productTypeId: text("product_type_id")
      .notNull()
      .references(() => productTypes.id),
    taxonomyNodeId: integer("taxonomy_node_id"),
    extractedSchemaVersion: integer("extracted_schema_version"),
    title: text("title").notNull(),
    platform: text("platform"),
    releaseDate: text("release_date"),
    genre: text("genre"),
    salesVolume: integer("sales_volume").notNull().default(0),
    /** DB-driven metadata keyed by product_type_fields.key. */
    metadata: text("metadata", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("ix_products_type_volume").on(table.productTypeId, table.salesVolume),
    index("ix_products_taxonomy_node").on(table.taxonomyNodeId),
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
    /** @deprecated — kept for back-compat. Prefer `dimensions`. */
    condition: text("condition").notNull().default(""),
    /** JSON of pricing-axis field values (e.g. {condition:"loose"}, or {} for bourbon). */
    dimensions: text("dimensions", { mode: "json" })
      .notNull()
      .$type<Record<string, unknown>>()
      .default({}),
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
