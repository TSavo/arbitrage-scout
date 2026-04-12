/**
 * Integration tests for CommandPipeline — taxonomy-driven flow.
 *
 * The pipeline now routes listings through three tiers:
 *   Tier 1 (external_id): adapter gave us pc_product_id / upc / discogs_id /
 *     etc. We skip to persist + price + evaluate.
 *   Tier 2 (cached):      listing was previously stored with confirmed items.
 *     We re-evaluate without LLM.
 *   Tier 3 (full_walk):   novel listing → extract + classify + validateFields
 *     + resolveIdentity + persist + price + evaluate.
 *
 * Tests use an in-memory SQLite DB seeded with a minimal taxonomy tree.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createTestDb, seedTestData } from "@/__tests__/helpers";

type TestDbBundle = ReturnType<typeof createTestDb>;

let testBundle: TestDbBundle = createTestDb();
seedTestData(testBundle.db);

vi.mock("@/db/client", () => ({
  get db() {
    return testBundle.db;
  },
  get sqlite() {
    return testBundle.sqlite;
  },
}));

vi.mock("@/db/repos/EmbeddingRepo", () => {
  const stub = {
    exists: vi.fn().mockResolvedValue(false),
    getOrCompute: vi.fn().mockResolvedValue(null),
    findSimilar: vi.fn().mockResolvedValue([]),
  };
  return {
    embeddingRepo: stub,
    EmbeddingRepo: class {},
  };
});

// Any network fetch during the test should fail loudly.
const originalFetch = globalThis.fetch;
beforeEach(() => {
  testBundle = createTestDb();
  seedTestData(testBundle.db);
  globalThis.fetch = vi.fn().mockRejectedValue(
    new Error("fetch should not be called in tests"),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

// Import AFTER mocks are set up.
import { CommandPipeline } from "../pipeline";
import type { RawListing } from "../types";
import * as schema from "@/db/schema";

function makeRaw(overrides: Partial<RawListing> = {}): RawListing {
  return {
    marketplaceId: "shopgoodwill",
    listingId: "sgw-1",
    title: "Super Mario 64 Nintendo 64 Cartridge",
    priceUsd: 5,
    shippingUsd: 0,
    url: "https://shopgoodwill.com/item/1",
    numBids: 0,
    itemCount: 1,
    scrapedAt: Date.now(),
    extra: {},
    ...overrides,
  };
}

describe("CommandPipeline — Tier 1 (external_id fast path)", () => {
  it("creates opportunity for a PriceCharting-known product below market", async () => {
    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });

    const raw = makeRaw({
      marketplaceId: "pricecharting",
      listingId: "pc-offer-1",
      title: "Super Mario 64",
      priceUsd: 5,
      extra: { pc_product_id: "pc-1", include: "complete" },
    });

    const result = await pipeline.processListing(raw);

    expect(result.opportunities.length).toBe(1);
    const opp = result.opportunities[0];
    expect(opp.productId).toBe("pc-1");
    expect(opp.condition).toBe("cib");
    expect(opp.profit).toBeGreaterThan(5);
    expect(result.commands.some((c) => c.type === "fast_path")).toBe(true);
    expect(result.commands.some((c) => c.type === "detect_tier")).toBe(true);
  });

  it("records detect_tier as external_id when pc_product_id matches an existing product", async () => {
    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });
    const raw = makeRaw({
      marketplaceId: "pricecharting",
      listingId: "pc-tier1",
      title: "Super Mario 64",
      priceUsd: 5,
      extra: { pc_product_id: "pc-1", include: "complete" },
    });

    const result = await pipeline.processListing(raw);
    const tierCmd = result.commands.find((c) => c.type === "detect_tier")!;
    expect(tierCmd).toBeTruthy();
    expect((tierCmd.output as { kind: string }).kind).toBe("external_id");
  });

  it("skips when profit below threshold on fast path", async () => {
    const pipeline = new CommandPipeline({ minProfitUsd: 25, minMarginPct: 0.3 });

    const raw = makeRaw({
      marketplaceId: "pricecharting",
      listingId: "pc-offer-2",
      title: "GoldenEye 007",
      priceUsd: 14,
      extra: { pc_product_id: "pc-2", include: "disc only" }, // loose
    });

    const result = await pipeline.processListing(raw);

    expect(result.opportunities.length).toBe(0);
    expect(result.commands.some((c) => c.type === "fast_path")).toBe(true);
  });

  it("never runs extract/classify on tier-1 fast path", async () => {
    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });
    const raw = makeRaw({
      marketplaceId: "pricecharting",
      listingId: "pc-fast",
      title: "Super Mario 64",
      priceUsd: 5,
      extra: { pc_product_id: "pc-1", include: "complete" },
    });
    const result = await pipeline.processListing(raw);
    const cmdTypes = result.commands.map((c) => c.type);
    expect(cmdTypes).not.toContain("extract");
    expect(cmdTypes).not.toContain("classify");
    expect(cmdTypes).not.toContain("resolve_identity");
  });
});

describe("CommandPipeline — Tier 2 (cached re-evaluate)", () => {
  it("re-evaluates a previously-seen listing without LLM", async () => {
    const { db } = testBundle;
    const now = new Date().toISOString();

    const listing = db.insert(schema.listings).values({
      marketplaceId: "shopgoodwill",
      marketplaceListingId: "sgw-existing",
      title: "Super Mario 64",
      priceUsd: 5,
      shippingUsd: 0,
      isLot: false,
      firstSeenAt: now,
      lastSeenAt: now,
      isActive: true,
    }).returning({ id: schema.listings.id }).get();

    db.insert(schema.listingItems).values({
      listingId: listing.id,
      productId: "pc-1",
      quantity: 1,
      condition: "loose",
      conditionDetails: { condition: "loose" },
      estimatedValueUsd: 25,
      confidence: 0.9,
      confirmed: true,
      rawExtraction: {},
    }).run();

    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });
    const raw = makeRaw({
      marketplaceId: "shopgoodwill",
      listingId: "sgw-existing",
      priceUsd: 3, // cheaper than before
    });

    const result = await pipeline.processListing(raw);

    expect(result.opportunities.length).toBe(1);
    expect(result.opportunities[0].productId).toBe("pc-1");
    expect(result.commands.some((c) => c.type === "fast_path")).toBe(true);
    const tier = result.commands.find((c) => c.type === "detect_tier")!;
    expect((tier.output as { kind: string }).kind).toBe("cached");
  });

  it("falls through to full_walk when existing items are not confirmed", async () => {
    const { db } = testBundle;
    const now = new Date().toISOString();

    const listing = db.insert(schema.listings).values({
      marketplaceId: "shopgoodwill",
      marketplaceListingId: "sgw-unconfirmed",
      title: "Mystery Lot",
      priceUsd: 5,
      shippingUsd: 0,
      isLot: false,
      firstSeenAt: now,
      lastSeenAt: now,
      isActive: true,
    }).returning({ id: schema.listings.id }).get();

    db.insert(schema.listingItems).values({
      listingId: listing.id,
      productId: "pc-2",
      quantity: 1,
      condition: "loose",
      conditionDetails: {},
      estimatedValueUsd: 15,
      confidence: 0.4,
      confirmed: false,
      rawExtraction: {},
    }).run();

    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });
    const raw = makeRaw({
      marketplaceId: "shopgoodwill",
      listingId: "sgw-unconfirmed",
      priceUsd: 3,
    });

    const result = await pipeline.processListing(raw);
    // Not confirmed → tier = full_walk, not cached.
    const tier = result.commands.find((c) => c.type === "detect_tier")!;
    expect((tier.output as { kind: string }).kind).toBe("full_walk");
  });
});

describe("CommandPipeline — Tier 3 (full walk)", () => {
  it("runs all phases for a novel listing (no LLM)", async () => {
    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });
    const raw = makeRaw({
      marketplaceId: "shopgoodwill",
      listingId: "sgw-novel-1",
      title: "Nintendo 64 Super Mario 64 cartridge",
      priceUsd: 5,
    });

    const result = await pipeline.processListing(raw);

    const cmdTypes = result.commands.map((c) => c.type);
    expect(cmdTypes).toContain("validate");
    expect(cmdTypes).toContain("detect_tier");
    expect(cmdTypes).toContain("extract");
    expect(cmdTypes).toContain("classify");
    expect(cmdTypes).toContain("validate_fields");
    expect(cmdTypes).toContain("resolve_identity");
    expect(cmdTypes).toContain("persist");
    expect(cmdTypes).toContain("price");
    expect(cmdTypes).toContain("evaluate");
  });

  it("creates a new product row when identity resolution has no match", async () => {
    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });
    const raw = makeRaw({
      marketplaceId: "shopgoodwill",
      listingId: "sgw-novel-2",
      title: "Some Obscure 1990 Collectible",
      priceUsd: 10,
    });

    await pipeline.processListing(raw);

    const prods = testBundle.db.select().from(schema.products).all();
    // At minimum we should have the seeded products plus 1 new.
    expect(prods.length).toBeGreaterThanOrEqual(6);
  });

  it("persists the listing row on the full walk", async () => {
    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });
    const raw = makeRaw({
      marketplaceId: "shopgoodwill",
      listingId: "sgw-persist-test",
      title: "Some Item",
      priceUsd: 5,
    });

    await pipeline.processListing(raw);

    const listing = testBundle.db.query.listings.findFirst({
      where: undefined,
    });
    // Use drizzle query
    const listings = testBundle.db.select().from(schema.listings).all();
    expect(listings.some((l) => l.marketplaceListingId === "sgw-persist-test")).toBe(true);
    void listing;
  });
});

describe("detectTier", () => {
  it("returns external_id when pc_product_id maps to an existing product", async () => {
    const { detectTier } = await import("../commands/detect_tier");
    const raw = makeRaw({
      marketplaceId: "pricecharting",
      listingId: "x",
      extra: { pc_product_id: "pc-1" },
    });
    const r = await detectTier(raw);
    expect(r.kind).toBe("external_id");
    if (r.kind === "external_id") {
      expect(r.productId).toBe("pc-1");
    }
  });

  it("returns full_walk when no identifier matches and listing is new", async () => {
    const { detectTier } = await import("../commands/detect_tier");
    const raw = makeRaw({ extra: { pc_product_id: "does-not-exist" } });
    const r = await detectTier(raw);
    expect(r.kind).toBe("full_walk");
  });

  it("returns cached when listing was previously seen with confirmed items", async () => {
    const { db } = testBundle;
    const now = new Date().toISOString();
    const listing = db.insert(schema.listings).values({
      marketplaceId: "shopgoodwill",
      marketplaceListingId: "sgw-cache-tier",
      title: "Test",
      priceUsd: 1,
      shippingUsd: 0,
      isLot: false,
      firstSeenAt: now,
      lastSeenAt: now,
      isActive: true,
    }).returning({ id: schema.listings.id }).get();
    db.insert(schema.listingItems).values({
      listingId: listing.id,
      productId: "pc-1",
      quantity: 1,
      condition: "loose",
      conditionDetails: {},
      confidence: 1,
      confirmed: true,
      rawExtraction: {},
    }).run();

    const { detectTier } = await import("../commands/detect_tier");
    const raw = makeRaw({ listingId: "sgw-cache-tier" });
    const r = await detectTier(raw);
    expect(r.kind).toBe("cached");
    if (r.kind === "cached") {
      expect(r.productIds).toContain("pc-1");
    }
  });
});

describe("validateFields", () => {
  it("coerces strings, numbers, booleans against the schema", async () => {
    const { validateFields } = await import("../commands/validate_fields");
    const { taxonomyRepo } = await import("@/db/repos/TaxonomyRepo");
    const node = await taxonomyRepo.getNodeBySlugPath(["retro_game"]);
    expect(node).not.toBeNull();
    const schemaObj = await taxonomyRepo.getAccumulatedSchema(node!.id);

    const out = validateFields({
      extracted: { condition: "CIB", junk: "ignored" },
      schema: schemaObj,
    });
    expect(out.values.get("condition")).toBe("cib");
    // Extracted fields not in schema are dropped.
    expect(out.values.has("junk")).toBe(false);
  });

  it("flags values that violate enum constraints", async () => {
    const { validateFields } = await import("../commands/validate_fields");
    const { taxonomyRepo } = await import("@/db/repos/TaxonomyRepo");
    const node = await taxonomyRepo.getNodeBySlugPath(["retro_game"]);
    const schemaObj = await taxonomyRepo.getAccumulatedSchema(node!.id);

    const out = validateFields({
      extracted: { condition: "wobbly" },
      schema: schemaObj,
    });
    expect(out.values.has("condition")).toBe(false);
    expect(out.invalid.some((i) => i.key === "condition")).toBe(true);
  });
});

describe("writePricePoint", () => {
  it("derives dimensions from pricing-axis fields", async () => {
    const { writePricePoint } = await import("../commands/write_price_point");
    const { taxonomyRepo } = await import("@/db/repos/TaxonomyRepo");
    const node = await taxonomyRepo.getNodeBySlugPath(["retro_game"]);
    const schemaObj = await taxonomyRepo.getAccumulatedSchema(node!.id);

    const fields = new Map<string, string | number | boolean>();
    fields.set("condition", "loose");

    const result = await writePricePoint({
      productId: "pc-1",
      source: "ebay",
      priceUsd: 30,
      fields,
      schema: schemaObj,
    });
    expect(result.inserted).toBe(true);
    expect(result.dimensions).toEqual({ condition: "loose" });

    const rows = testBundle.db.select().from(schema.pricePoints).all();
    expect(rows.some((r) => r.source === "ebay" && r.priceUsd === 30)).toBe(true);
  });

  it("refuses non-positive price", async () => {
    const { writePricePoint } = await import("../commands/write_price_point");
    const { taxonomyRepo } = await import("@/db/repos/TaxonomyRepo");
    const node = await taxonomyRepo.getNodeBySlugPath(["retro_game"]);
    const schemaObj = await taxonomyRepo.getAccumulatedSchema(node!.id);

    const result = await writePricePoint({
      productId: "pc-1",
      source: "ebay",
      priceUsd: 0,
      fields: new Map(),
      schema: schemaObj,
    });
    expect(result.inserted).toBe(false);
  });
});

describe("DB-driven pricing dimensions (legacy helpers)", () => {
  it("prices a bourbon product with no pricing axes (single price)", async () => {
    const { lookupPrices, getMarketPrice } = await import("../commands/price");

    const matches = new Map<number, import("../types").CatalogMatch | null>();
    matches.set(0, {
      productId: "pc-bourbon-1",
      title: "Pappy Van Winkle 23",
      score: 0.95,
      method: "fts5",
      productTypeId: "bourbon",
    });

    const result = await lookupPrices({ matches });
    expect(result.foundCount).toBe(1);
    const priceData = result.prices.get("pc-bourbon-1")!;
    expect(getMarketPrice(priceData)).toBe(3500);
    expect(priceData.entries.length).toBe(1);
    expect(priceData.entries[0].dimensions).toEqual({});
  });

  it("picks the right sports-card price for multi-axis dimensions", async () => {
    const { lookupPrices, getMarketPrice } = await import("../commands/price");

    const matches = new Map<number, import("../types").CatalogMatch | null>();
    matches.set(0, {
      productId: "pc-sports-1",
      title: "Mickey Mantle 1952 Topps",
      score: 0.9,
      method: "fts5",
      productTypeId: "sports_card",
    });

    const result = await lookupPrices({ matches });
    const priceData = result.prices.get("pc-sports-1")!;

    expect(
      getMarketPrice(priceData, { condition: "graded", grade: 9, grading_company: "PSA" }),
    ).toBe(25000);
    expect(
      getMarketPrice(priceData, { condition: "graded", grade: 8, grading_company: "PSA" }),
    ).toBe(5000);
    expect(getMarketPrice(priceData, { condition: "raw" })).toBe(200);
  });

  it("retro_game (MTG-style single-axis) picks cib vs loose from dimensions", async () => {
    const { lookupPrices, getMarketPrice } = await import("../commands/price");

    const matches = new Map<number, import("../types").CatalogMatch | null>();
    matches.set(0, {
      productId: "pc-1",
      title: "Super Mario 64",
      score: 0.9,
      method: "fts5",
      productTypeId: "retro_game",
    });

    const result = await lookupPrices({ matches });
    const priceData = result.prices.get("pc-1")!;
    expect(getMarketPrice(priceData, { condition: "cib" })).toBe(45);
    expect(getMarketPrice(priceData, { condition: "loose" })).toBe(25);
  });

  it("ProductTypeRepo.getSchema returns DB-driven fields with enum values", async () => {
    const { productTypeRepo } = await import("@/db/repos/ProductTypeRepo");
    const s = await productTypeRepo.getSchema("sports_card");
    expect(s).not.toBeNull();
    expect(s!.id).toBe("sports_card");
    const keys = s!.fields.map((f) => f.key);
    expect(keys).toContain("condition");
    expect(keys).toContain("grade");
    expect(keys).toContain("grading_company");
    expect(keys).toContain("player");

    const axes = s!.fields.filter((f) => f.isPricingAxis).map((f) => f.key);
    expect(axes.sort()).toEqual(["condition", "grade", "grading_company"]);

    const condField = s!.fields.find((f) => f.key === "condition")!;
    expect(condField.enumValues?.map((e) => e.value).sort()).toEqual(["graded", "raw"]);
  });

  it("bourbon schema has zero pricing axes", async () => {
    const { productTypeRepo } = await import("@/db/repos/ProductTypeRepo");
    const s = await productTypeRepo.getSchema("bourbon");
    expect(s).not.toBeNull();
    const axes = s!.fields.filter((f) => f.isPricingAxis);
    expect(axes.length).toBe(0);
  });
});

describe("CommandPipeline metrics & events", () => {
  it("accumulates metrics across calls", async () => {
    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });

    await pipeline.processListing(makeRaw({
      marketplaceId: "pricecharting",
      listingId: "pc-a",
      title: "Super Mario 64",
      priceUsd: 5,
      extra: { pc_product_id: "pc-1", include: "complete" },
    }));

    await pipeline.processListing(makeRaw({
      marketplaceId: "pricecharting",
      listingId: "pc-b",
      title: "GoldenEye",
      priceUsd: 100,
      extra: { pc_product_id: "pc-2", include: "disc only" },
    }));

    const metrics = pipeline.getMetrics();
    expect(metrics.totalListings).toBe(2);
    expect(metrics.commands.length).toBeGreaterThanOrEqual(2);
    expect(metrics.totalErrors).toBe(0);
  });

  it("fires command.issued events for each command", async () => {
    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });

    const events: string[] = [];
    const unsubscribe = pipeline.onEvent((e) => {
      events.push(e.type);
    });

    await pipeline.processListing(makeRaw({
      marketplaceId: "pricecharting",
      listingId: "pc-evt",
      title: "Super Mario 64",
      priceUsd: 5,
      extra: { pc_product_id: "pc-1", include: "complete" },
    }));

    unsubscribe();

    expect(events).toContain("command.issued");
    expect(events).toContain("opportunity.found");
  });

  it("fires handler.error on thrown errors", async () => {
    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });

    const errors: Array<Record<string, unknown>> = [];
    pipeline.getEmitter().on("handler.error", (data) => {
      errors.push(data as Record<string, unknown>);
    });

    // Force error: monkey-patch listings.findFirst to throw.
    const original = testBundle.db.query.listings.findFirst;
    testBundle.db.query.listings.findFirst = (() => {
      throw new Error("forced failure");
    }) as typeof original;

    await expect(pipeline.processListing(makeRaw({
      marketplaceId: "shopgoodwill",
      listingId: "sgw-err",
      title: "Nintendo 64 Super Mario 64",
      priceUsd: 5,
    }))).rejects.toThrow("forced failure");

    expect(errors.length).toBeGreaterThan(0);

    testBundle.db.query.listings.findFirst = original;
  });
});
