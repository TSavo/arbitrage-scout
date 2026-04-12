/**
 * Integration tests for CommandPipeline.
 *
 * Uses an in-memory SQLite DB injected via vi.mock of @/db/client, so the
 * pipeline's store/price/check-existing paths hit a real DB. The Ollama
 * embedding repo is mocked (no network), and fetch is stubbed to ensure
 * no external calls.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
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
    getOrCompute: vi.fn().mockResolvedValue(undefined),
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
import type { RawListing, Opportunity } from "../types";
import type { ProductTypeSchema } from "../commands/extract";
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

function testSchema(): ProductTypeSchema[] {
  return [
    {
      id: "retro_game",
      name: "Retro Video Game",
      fields: [
        {
          key: "platform",
          label: "Platform",
          dataType: "string",
          isInteger: false,
          isRequired: false,
          isSearchable: true,
          searchWeight: 2,
          isIdentifier: false,
          isPricingAxis: false,
          displayPriority: 20,
          isHidden: false,
        },
        {
          key: "condition",
          label: "Condition",
          dataType: "string",
          isInteger: false,
          isRequired: false,
          isSearchable: false,
          searchWeight: 1,
          isIdentifier: false,
          isPricingAxis: true,
          displayPriority: 5,
          isHidden: false,
          enumValues: [
            { value: "loose", label: "Loose", displayOrder: 10 },
            { value: "cib", label: "Complete in box", displayOrder: 20 },
            { value: "new_sealed", label: "New sealed", displayOrder: 30 },
          ],
        },
      ],
    },
    {
      id: "pokemon_card",
      name: "Pokemon Card",
      fields: [
        {
          key: "set_name",
          label: "Set name",
          dataType: "string",
          isInteger: false,
          isRequired: false,
          isSearchable: true,
          searchWeight: 3,
          isIdentifier: true,
          isPricingAxis: false,
          displayPriority: 10,
          isHidden: false,
        },
        {
          key: "card_number",
          label: "Card number",
          dataType: "string",
          isInteger: false,
          isRequired: false,
          isSearchable: true,
          searchWeight: 3,
          isIdentifier: true,
          isPricingAxis: false,
          displayPriority: 20,
          isHidden: false,
        },
        {
          key: "condition",
          label: "Condition",
          dataType: "string",
          isInteger: false,
          isRequired: false,
          isSearchable: false,
          searchWeight: 1,
          isIdentifier: false,
          isPricingAxis: true,
          displayPriority: 5,
          isHidden: false,
          enumValues: [
            { value: "loose", label: "Loose", displayOrder: 10 },
            { value: "graded", label: "Graded", displayOrder: 20 },
          ],
        },
      ],
    },
  ];
}

describe("CommandPipeline.processListing — known product fast path", () => {
  it("creates opportunity for a PriceCharting-known product below market", async () => {
    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });

    const raw = makeRaw({
      marketplaceId: "pricecharting",
      listingId: "pc-offer-1",
      title: "Super Mario 64",
      priceUsd: 5,
      extra: { pc_product_id: "pc-1", include: "complete" },
    });

    const result = await pipeline.processListing(raw, testSchema());

    expect(result.opportunities.length).toBe(1);
    const opp = result.opportunities[0];
    expect(opp.productId).toBe("pc-1");
    expect(opp.condition).toBe("cib");
    expect(opp.profit).toBeGreaterThan(5);
    // fast_path command should be recorded
    expect(result.commands.some((c) => c.type === "fast_path")).toBe(true);
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

    const result = await pipeline.processListing(raw, testSchema());

    expect(result.opportunities.length).toBe(0);
    expect(result.commands.some((c) => c.type === "fast_path")).toBe(true);
  });
});

describe("CommandPipeline.processListing — existing-items re-evaluate path", () => {
  it("re-evaluates an existing listing without LLM", async () => {
    const { db } = testBundle;
    const now = new Date().toISOString();

    // Pre-seed a listing and a confirmed item
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
      conditionDetails: {},
      estimatedValueUsd: 25,
      confidence: 0.9,
      confirmed: true,
      rawExtraction: {},
    }).run();

    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });
    const raw = makeRaw({
      marketplaceId: "shopgoodwill",
      listingId: "sgw-existing",
      priceUsd: 3, // cheaper
    });

    const result = await pipeline.processListing(raw, testSchema());

    expect(result.opportunities.length).toBe(1);
    expect(result.opportunities[0].productId).toBe("pc-1");
    expect(result.commands.some((c) => c.type === "reevaluate")).toBe(true);
  });

  it("returns empty when existing items are not confirmed", async () => {
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

    const result = await pipeline.processListing(raw, testSchema());
    expect(result.opportunities.length).toBe(0);
  });
});

describe("CommandPipeline.processListing — full rule-based flow (no LLM)", () => {
  it("returns empty when no items extracted from unrelated listing", async () => {
    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });
    const raw = makeRaw({
      marketplaceId: "shopgoodwill",
      listingId: "sgw-furniture",
      title: "Used Office Chair",
      priceUsd: 20,
    });

    const result = await pipeline.processListing(raw, testSchema());
    expect(result.opportunities.length).toBe(0);
    expect(result.commands.some((c) => c.type === "extract")).toBe(true);
  });

  it("runs extract→match→dedup→confirm→price→evaluate when items present", async () => {
    // FTS5 and difflib will both error-catch to null matches (no fts5 table),
    // so no opportunities expected — but all stages should execute.
    const pipeline = new CommandPipeline({ minProfitUsd: 5, minMarginPct: 0.3 });
    const raw = makeRaw({
      title: "Nintendo 64 Super Mario 64 cartridge",
      priceUsd: 5,
    });

    const result = await pipeline.processListing(raw, testSchema());

    const cmdTypes = result.commands.map((c) => c.type);
    expect(cmdTypes).toContain("validate");
    expect(cmdTypes).toContain("extract");
    expect(cmdTypes).toContain("match");
    expect(cmdTypes).toContain("dedup");
    expect(cmdTypes).toContain("confirm");
    expect(cmdTypes).toContain("price");
    expect(cmdTypes).toContain("evaluate");
  });

  it("returns empty below profit threshold", async () => {
    const pipeline = new CommandPipeline({
      minProfitUsd: 1000, // unattainable
      minMarginPct: 0.3,
    });
    const raw = makeRaw({
      marketplaceId: "pricecharting",
      listingId: "pc-offer-hi",
      title: "Super Mario 64",
      priceUsd: 5,
      extra: { pc_product_id: "pc-1", include: "disc only" },
    });

    const result = await pipeline.processListing(raw, testSchema());
    expect(result.opportunities.length).toBe(0);
  });
});

describe("DB-driven pricing dimensions", () => {
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
    // No dimensions passed — bourbon has no pricing axes.
    expect(getMarketPrice(priceData)).toBe(3500);
    // Entries have empty dimensions (no condition).
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

    // PSA 9 → $25,000
    expect(
      getMarketPrice(priceData, { condition: "graded", grade: 9, grading_company: "PSA" }),
    ).toBe(25000);
    // PSA 8 → $5,000
    expect(
      getMarketPrice(priceData, { condition: "graded", grade: 8, grading_company: "PSA" }),
    ).toBe(5000);
    // Raw → $200
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
    }), testSchema());

    await pipeline.processListing(makeRaw({
      marketplaceId: "pricecharting",
      listingId: "pc-b",
      title: "GoldenEye",
      priceUsd: 100,
      extra: { pc_product_id: "pc-2", include: "disc only" },
    }), testSchema());

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
    }), testSchema());

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

    // Force error: pass a listing that makes validate pass but then fails in
    // checkExistingItems by pointing at a non-existent marketplace
    // (it won't actually throw — so instead we inject an invalid pc_product_id)
    // We'll simulate by mocking db.query.listings.findFirst to throw.
    const original = testBundle.db.query.listings.findFirst;
    testBundle.db.query.listings.findFirst = (() => {
      throw new Error("forced failure");
    }) as typeof original;

    await expect(pipeline.processListing(makeRaw({
      marketplaceId: "shopgoodwill",
      listingId: "sgw-err",
      title: "Nintendo 64 Super Mario 64",
      priceUsd: 5,
    }), testSchema())).rejects.toThrow("forced failure");

    expect(errors.length).toBeGreaterThan(0);

    testBundle.db.query.listings.findFirst = original;
  });
});
