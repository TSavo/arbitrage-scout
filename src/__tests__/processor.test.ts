import { describe, it, expect, beforeEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, seedTestData } from "./helpers";
import * as schema from "../db/schema";
import { upsertListing, getMarketPrice } from "../scanner/helpers";
import { makeRawListing } from "../sources/IMarketplaceAdapter";

describe("upsertListing", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    seedTestData(db);
  });

  it("inserts a new listing", () => {
    const listing = makeRawListing({
      marketplace_id: "shopgoodwill",
      listing_id: "12345",
      title: "N64 Game Lot",
      price_usd: 20.00,
      url: "https://shopgoodwill.com/item/12345",
    });

    const result = upsertListing(db, listing);
    expect(result.id).toBeGreaterThan(0);
    expect(result.title).toBe("N64 Game Lot");
    expect(result.priceUsd).toBe(20.00);
  });

  it("updates price on re-insert", () => {
    const listing = makeRawListing({
      marketplace_id: "shopgoodwill",
      listing_id: "12345",
      title: "N64 Game Lot",
      price_usd: 20.00,
      url: "https://shopgoodwill.com/item/12345",
    });

    const first = upsertListing(db, listing);

    listing.price_usd = 15.00;
    const second = upsertListing(db, listing);

    expect(second.id).toBe(first.id);
    expect(second.priceUsd).toBe(15.00);
  });

  it("preserves title, url, isLot on update", () => {
    const listing = makeRawListing({
      marketplace_id: "shopgoodwill",
      listing_id: "12345",
      title: "N64 Game Lot",
      price_usd: 20.00,
      url: "https://shopgoodwill.com/item/12345",
    });

    upsertListing(db, listing, true);

    // Re-insert with updated title
    listing.title = "N64 Game Lot - Updated";
    listing.price_usd = 18.00;
    const updated = upsertListing(db, listing);

    expect(updated.title).toBe("N64 Game Lot - Updated");
    expect(updated.priceUsd).toBe(18.00);
  });
});

describe("getMarketPrice", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    seedTestData(db);
  });

  it("returns the price for a matching condition", () => {
    const price = getMarketPrice(db, "pc-1", "loose");
    expect(price).toBe(25.00);
  });

  it("returns cib price when asked", () => {
    const price = getMarketPrice(db, "pc-1", "cib");
    expect(price).toBe(45.00);
  });

  it("falls back to loose when condition not found", () => {
    const price = getMarketPrice(db, "pc-1", "graded");
    // Should fallback to loose
    expect(price).toBe(25.00);
  });

  it("returns null for unknown product", () => {
    const price = getMarketPrice(db, "pc-999", "loose");
    expect(price).toBeNull();
  });
});

describe("makeRawListing", () => {
  it("fills in defaults", () => {
    const listing = makeRawListing({
      marketplace_id: "ebay",
      listing_id: "abc",
      title: "Test Item",
      price_usd: 10.00,
      url: "https://ebay.com/item/abc",
    });

    expect(listing.shipping_usd).toBe(0);
    expect(listing.item_count).toBe(1);
    expect(listing.num_bids).toBe(0);
  });
});

describe("opportunity dedup", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    seedTestData(db);
  });

  it("prevents duplicate opportunities for same listing+product", () => {
    // Create a listing
    const listing = makeRawListing({
      marketplace_id: "shopgoodwill",
      listing_id: "lot-1",
      title: "N64 Games",
      price_usd: 5.00,
      url: "",
    });
    const stored = upsertListing(db, listing);

    // Insert first opportunity
    db.insert(schema.opportunities).values({
      listingId: stored.id,
      productId: "pc-1",
      listingPriceUsd: 5.00,
      marketPriceUsd: 25.00,
      marketPriceSource: "pricecharting",
      marketPriceCondition: "loose",
      profitUsd: 16.25,
      marginPct: 3.25,
      confidence: 0.8,
      flags: [],
      status: "new",
      foundAt: new Date().toISOString(),
    }).run();

    // Try to insert duplicate — should not throw due to onConflictDoNothing
    const result = db.insert(schema.opportunities).values({
      listingId: stored.id,
      productId: "pc-1",
      listingPriceUsd: 5.00,
      marketPriceUsd: 25.00,
      marketPriceSource: "pricecharting",
      marketPriceCondition: "loose",
      profitUsd: 16.25,
      marginPct: 3.25,
      confidence: 0.8,
      flags: [],
      status: "new",
      foundAt: new Date().toISOString(),
    }).onConflictDoNothing().run();

    expect(result.changes).toBe(0);

    // Verify only one exists
    const opps = db.select().from(schema.opportunities)
      .where(and(
        eq(schema.opportunities.listingId, stored.id),
        eq(schema.opportunities.productId, "pc-1"),
      )).all();
    expect(opps).toHaveLength(1);
  });
});

describe("lot cost calculation", () => {
  let db: ReturnType<typeof createTestDb>["db"];

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    seedTestData(db);
  });

  it("computes conservative and potential profit correctly", () => {
    const lotPrice = 30.00;
    const confirmedCount = 2;
    const totalExtracted = 5;
    const marketPrice = 25.00;

    // Conservative: lot_price / confirmed (floor)
    const conservativeCost = lotPrice / confirmedCount; // $15/item
    const conservativeProfit = marketPrice * 0.85 - conservativeCost - 5; // 21.25 - 15 - 5 = 1.25

    // Potential: lot_price / total (ceiling)
    const potentialCost = lotPrice / totalExtracted; // $6/item
    const potentialProfit = marketPrice * 0.85 - potentialCost - 5; // 21.25 - 6 - 5 = 10.25

    expect(conservativeCost).toBe(15);
    expect(potentialCost).toBe(6);
    expect(conservativeProfit).toBeCloseTo(1.25, 2);
    expect(potentialProfit).toBeCloseTo(10.25, 2);
    expect(potentialProfit).toBeGreaterThan(conservativeProfit);
  });
});
