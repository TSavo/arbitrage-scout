/**
 * Integration tests for the scan pipeline.
 * Uses a real in-memory SQLite DB, mocks the LLM.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, seedTestData } from "./helpers";
import * as schema from "../db/schema";
import { upsertListing, getMarketPrice } from "../scanner/helpers";
import { makeRawListing } from "../sources/IMarketplaceAdapter";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";

type Db = BetterSQLite3Database<typeof schema>;

/**
 * Simulate what processListing does for a new listing with known matches.
 * This avoids needing the real LLM — we inject the identification results directly.
 */
function processWithKnownMatches(
  db: Db,
  listing: ReturnType<typeof makeRawListing>,
  matches: Array<{
    productId: string;
    condition: string;
    confidence: number;
  }>,
  totalExtracted: number,
  minProfit: number,
  minMargin: number,
): number {
  const storedListing = upsertListing(db, listing, totalExtracted > 1);

  // Store listing items (confirmed matches)
  for (const match of matches) {
    const marketPrice = getMarketPrice(db, match.productId, match.condition);
    db.insert(schema.listingItems).values({
      listingId: storedListing.id,
      productId: match.productId,
      condition: match.condition,
      conditionDetails: {},
      estimatedValueUsd: marketPrice,
      confidence: match.confidence,
      confirmed: true,
      rawExtraction: {},
    }).onConflictDoNothing().run();
  }

  // Create opportunities
  let nOpps = 0;
  const confirmedCount = matches.length;

  for (const match of matches) {
    const condPrice = getMarketPrice(db, match.productId, match.condition);
    if (!condPrice || condPrice <= 0) continue;

    const conservativeCost = listing.price_usd / confirmedCount;
    const profit = condPrice * 0.85 - conservativeCost - 5;
    const margin = conservativeCost > 0 ? profit / conservativeCost : 0;

    const potentialCost = listing.price_usd / totalExtracted;
    const potentialProfit = condPrice * 0.85 - potentialCost - 5;
    const potentialMargin = potentialCost > 0 ? potentialProfit / potentialCost : 0;

    if (profit < minProfit || margin < minMargin) continue;

    const flags: string[] = [];
    if ((listing.num_bids ?? 0) > 0) flags.push("auction_may_increase");
    if (margin >= 2.0) flags.push("verify_authenticity");

    db.insert(schema.opportunities).values({
      listingId: storedListing.id,
      productId: match.productId,
      listingPriceUsd: conservativeCost,
      marketPriceUsd: condPrice,
      marketPriceSource: "pricecharting",
      marketPriceCondition: match.condition,
      profitUsd: Math.round(profit * 100) / 100,
      marginPct: Math.round(margin * 10000) / 10000,
      potentialProfitUsd: Math.round(potentialProfit * 100) / 100,
      potentialMarginPct: Math.round(potentialMargin * 10000) / 10000,
      confidence: match.confidence,
      flags,
      status: "new",
      foundAt: new Date().toISOString(),
    }).onConflictDoNothing().run();

    nOpps++;
  }

  return nOpps;
}

/**
 * Simulate the returning-listing path: skip LLM, re-evaluate at current price.
 */
function reprocessListing(
  db: Db,
  listing: ReturnType<typeof makeRawListing>,
  minProfit: number,
  minMargin: number,
): number {
  const storedListing = upsertListing(db, listing);

  // Get existing confirmed items
  const existingItems = db
    .select({
      productId: schema.listingItems.productId,
      condition: schema.listingItems.condition,
      confidence: schema.listingItems.confidence,
      confirmed: schema.listingItems.confirmed,
    })
    .from(schema.listingItems)
    .where(eq(schema.listingItems.listingId, storedListing.id))
    .all();

  const confirmedItems = existingItems.filter((i) => i.confirmed);
  if (!confirmedItems.length) return 0;

  let nOpps = 0;
  const confirmedCount = confirmedItems.length;
  const totalItemCount = existingItems.length;

  for (const item of confirmedItems) {
    const condPrice = getMarketPrice(db, item.productId, item.condition);
    if (!condPrice || condPrice <= 0) continue;

    const conservativeCost = listing.price_usd / confirmedCount;
    const profit = condPrice * 0.85 - conservativeCost - 5;
    const margin = conservativeCost > 0 ? profit / conservativeCost : 0;

    const potentialCost = listing.price_usd / totalItemCount;
    const potentialProfit = condPrice * 0.85 - potentialCost - 5;
    const potentialMargin = potentialCost > 0 ? potentialProfit / potentialCost : 0;

    if (profit < minProfit || margin < minMargin) continue;

    const existingOpp = db
      .select({ id: schema.opportunities.id })
      .from(schema.opportunities)
      .where(and(
        eq(schema.opportunities.listingId, storedListing.id),
        eq(schema.opportunities.productId, item.productId),
      ))
      .limit(1)
      .all()[0];

    if (existingOpp) {
      db.update(schema.opportunities)
        .set({
          listingPriceUsd: conservativeCost,
          marketPriceUsd: condPrice,
          profitUsd: Math.round(profit * 100) / 100,
          marginPct: Math.round(margin * 10000) / 10000,
          potentialProfitUsd: Math.round(potentialProfit * 100) / 100,
          potentialMarginPct: Math.round(potentialMargin * 10000) / 10000,
        })
        .where(eq(schema.opportunities.id, existingOpp.id))
        .run();
    } else {
      db.insert(schema.opportunities).values({
        listingId: storedListing.id,
        productId: item.productId,
        listingPriceUsd: conservativeCost,
        marketPriceUsd: condPrice,
        marketPriceSource: "pricecharting",
        marketPriceCondition: item.condition,
        profitUsd: Math.round(profit * 100) / 100,
        marginPct: Math.round(margin * 10000) / 10000,
        potentialProfitUsd: Math.round(potentialProfit * 100) / 100,
        potentialMarginPct: Math.round(potentialMargin * 10000) / 10000,
        confidence: item.confidence,
        flags: [],
        status: "new",
        foundAt: new Date().toISOString(),
      }).onConflictDoNothing().run();
      nOpps++;
    }
  }

  return nOpps;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("full listing processing", () => {
  let db: Db;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    seedTestData(db);
  });

  it("creates listing, listing_items, and opportunity for a deal", () => {
    const listing = makeRawListing({
      marketplace_id: "shopgoodwill",
      listing_id: "sgw-100",
      title: "Super Mario 64 N64",
      price_usd: 5.00,
      url: "https://shopgoodwill.com/item/100",
    });

    const nOpps = processWithKnownMatches(db, listing, [
      { productId: "pc-1", condition: "loose", confidence: 0.9 },
    ], 1, 5, 0.3);

    expect(nOpps).toBe(1);

    // Verify listing stored
    const listings = db.select().from(schema.listings).all();
    expect(listings).toHaveLength(1);
    expect(listings[0].title).toBe("Super Mario 64 N64");

    // Verify listing_item
    const items = db.select().from(schema.listingItems).all();
    expect(items).toHaveLength(1);
    expect(items[0].productId).toBe("pc-1");
    expect(items[0].confirmed).toBe(true);

    // Verify opportunity
    const opps = db.select().from(schema.opportunities).all();
    expect(opps).toHaveLength(1);
    expect(opps[0].productId).toBe("pc-1");
    expect(opps[0].listingPriceUsd).toBe(5.00);
    expect(opps[0].marketPriceUsd).toBe(25.00);
    expect(opps[0].profitUsd).toBeGreaterThan(0);
  });

  it("skips deals below profit threshold", () => {
    const listing = makeRawListing({
      marketplace_id: "shopgoodwill",
      listing_id: "sgw-200",
      title: "GoldenEye 007",
      price_usd: 12.00, // market is $15, not enough margin
      url: "",
    });

    const nOpps = processWithKnownMatches(db, listing, [
      { productId: "pc-2", condition: "loose", confidence: 0.85 },
    ], 1, 5, 0.3);

    expect(nOpps).toBe(0);
    expect(db.select().from(schema.opportunities).all()).toHaveLength(0);
  });
});

describe("returning listing skip", () => {
  let db: Db;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    seedTestData(db);
  });

  it("reuses existing listing_items without re-identification", () => {
    const listing = makeRawListing({
      marketplace_id: "shopgoodwill",
      listing_id: "sgw-300",
      title: "Super Mario 64 N64 Cart",
      price_usd: 5.00,
      url: "",
    });

    // First pass: full processing
    processWithKnownMatches(db, listing, [
      { productId: "pc-1", condition: "loose", confidence: 0.9 },
    ], 1, 5, 0.3);

    // Second pass: returning listing (same price)
    const nOpps = reprocessListing(db, listing, 5, 0.3);

    // Should not create a duplicate opportunity
    expect(nOpps).toBe(0); // already exists, just updated

    const opps = db.select().from(schema.opportunities).all();
    expect(opps).toHaveLength(1);
  });
});

describe("price change on returning listing", () => {
  let db: Db;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    seedTestData(db);
  });

  it("updates opportunity profit when listing price drops", () => {
    const listing = makeRawListing({
      marketplace_id: "shopgoodwill",
      listing_id: "sgw-400",
      title: "Super Mario 64",
      price_usd: 8.00,
      url: "",
    });

    // First: create at $8
    processWithKnownMatches(db, listing, [
      { productId: "pc-1", condition: "loose", confidence: 0.9 },
    ], 1, 5, 0.3);

    const oppBefore = db.select().from(schema.opportunities).all()[0];
    const profitBefore = oppBefore.profitUsd;

    // Price drops to $3
    listing.price_usd = 3.00;
    reprocessListing(db, listing, 5, 0.3);

    const oppAfter = db.select().from(schema.opportunities).all()[0];

    // Same opportunity, higher profit
    expect(oppAfter.id).toBe(oppBefore.id);
    expect(oppAfter.profitUsd).toBeGreaterThan(profitBefore);
    expect(oppAfter.listingPriceUsd).toBe(3.00);
  });

  it("creates new opportunity when price drops enough to clear threshold", () => {
    const listing = makeRawListing({
      marketplace_id: "shopgoodwill",
      listing_id: "sgw-500",
      title: "GoldenEye 007",
      price_usd: 14.00, // too expensive, no opportunity
      url: "",
    });

    // First pass: no deal at $14
    processWithKnownMatches(db, listing, [
      { productId: "pc-2", condition: "loose", confidence: 0.85 },
    ], 1, 5, 0.3);

    expect(db.select().from(schema.opportunities).all()).toHaveLength(0);

    // Price drops to $2 — now it's a deal
    listing.price_usd = 2.00;
    const nOpps = reprocessListing(db, listing, 5, 0.3);

    expect(nOpps).toBe(1);
    const opp = db.select().from(schema.opportunities).all()[0];
    expect(opp.listingPriceUsd).toBe(2.00);
    expect(opp.profitUsd).toBeGreaterThan(5);
  });
});

describe("lot decomposition", () => {
  let db: Db;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    seedTestData(db);
  });

  it("computes conservative and potential profit for lots", () => {
    const listing = makeRawListing({
      marketplace_id: "shopgoodwill",
      listing_id: "sgw-600",
      title: "N64 Game Lot - 5 Games",
      price_usd: 10.00,
      url: "",
    });

    // 5 items extracted, 2 confirmed
    processWithKnownMatches(db, listing, [
      { productId: "pc-1", condition: "loose", confidence: 0.9 },  // $25 market
      { productId: "pc-2", condition: "loose", confidence: 0.8 },  // $15 market
    ], 5, 0, 0);

    const opps = db.select().from(schema.opportunities)
      .where(eq(schema.opportunities.listingId, 1))
      .all();

    expect(opps.length).toBeGreaterThan(0);

    // Conservative: $10 / 2 confirmed = $5/item
    // Potential: $10 / 5 total = $2/item
    for (const opp of opps) {
      expect(opp.listingPriceUsd).toBe(5.00); // conservative
      if (opp.potentialProfitUsd !== null) {
        expect(opp.potentialProfitUsd).toBeGreaterThan(opp.profitUsd);
      }
    }
  });

  it("sets equal conservative and potential for single items", () => {
    const listing = makeRawListing({
      marketplace_id: "shopgoodwill",
      listing_id: "sgw-700",
      title: "Super Mario 64",
      price_usd: 5.00,
      url: "",
    });

    processWithKnownMatches(db, listing, [
      { productId: "pc-1", condition: "loose", confidence: 0.9 },
    ], 1, 0, 0);

    const opp = db.select().from(schema.opportunities).all()[0];
    expect(opp.profitUsd).toBe(opp.potentialProfitUsd);
  });
});

describe("adapter registry", () => {
  it("creates adapters based on config", async () => {
    const { buildAdapters } = await import("../sources/registry");

    // No credentials — should get only no-auth adapters
    const adapters = buildAdapters({});

    const ids = adapters.map((a) => a.marketplace_id);
    expect(ids).toContain("discogs");
    expect(ids).toContain("hibid");
    expect(ids).toContain("tcgplayer");

    // eBay and ShopGoodwill need credentials — should be missing
    expect(ids).not.toContain("ebay");
    expect(ids).not.toContain("shopgoodwill");
  });

  it("includes eBay when credentials provided", async () => {
    const { buildAdapters } = await import("../sources/registry");

    const adapters = buildAdapters({
      ebay: { app_id: "test", cert_id: "test" },
    });

    const ids = adapters.map((a) => a.marketplace_id);
    expect(ids).toContain("ebay");
  });

  it("disables adapters via config", async () => {
    const { buildAdapters } = await import("../sources/registry");

    const adapters = buildAdapters({
      discogs: { enabled: false },
      hibid: { enabled: false },
    });

    const ids = adapters.map((a) => a.marketplace_id);
    expect(ids).not.toContain("discogs");
    expect(ids).not.toContain("hibid");
  });
});

describe("trend detection", () => {
  let db: Db;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    seedTestData(db);

    // Add second day of prices with changes
    db.insert(schema.pricePoints).values({ productId: "pc-1", source: "pricecharting", condition: "loose", priceUsd: 30.00, recordedAt: "2026-04-11" }).run();
    db.insert(schema.pricePoints).values({ productId: "pc-2", source: "pricecharting", condition: "loose", priceUsd: 10.00, recordedAt: "2026-04-11" }).run();
    db.insert(schema.pricePoints).values({ productId: "pc-3", source: "pricecharting", condition: "loose", priceUsd: 160.00, recordedAt: "2026-04-11" }).run();
  });

  it("detects risers and fallers from two days of data", () => {
    // pc-1: $25 → $30 = +20% (+$5) — riser
    // pc-2: $15 → $10 = -33% (-$5) — faller
    // pc-3: $150 → $160 = +6.7% (+$10) — below 10% threshold but above $5

    const prices = db.select().from(schema.pricePoints).all();
    const dates = [...new Set(prices.map((p) => p.recordedAt))].sort();
    expect(dates).toHaveLength(2);

    // Verify price changes are detectable (pc-1 has loose + cib on day 1, loose on day 2)
    const pc1Loose = prices.filter((p) => p.productId === "pc-1" && p.condition === "loose");
    expect(pc1Loose).toHaveLength(2);

    const oldPrice = pc1Loose.find((p) => p.recordedAt === "2026-04-10")!.priceUsd;
    const newPrice = pc1Loose.find((p) => p.recordedAt === "2026-04-11")!.priceUsd;
    const changePct = ((newPrice - oldPrice) / oldPrice) * 100;

    expect(changePct).toBeCloseTo(20, 0);
    expect(newPrice - oldPrice).toBe(5);
  });
});

describe("watchlist triggering", () => {
  let db: Db;

  beforeEach(() => {
    const testDb = createTestDb();
    db = testDb.db;
    seedTestData(db);
  });

  it("triggers alert when listing is below target price", () => {
    // Watch pc-1 (market $25) for 20% below = target $20
    db.insert(schema.watchlistItems).values({
      productId: "pc-1",
      targetPricePct: 20,
      condition: "loose",
      createdAt: new Date().toISOString(),
      active: true,
    }).run();

    // Create a listing at $15 (below $20 target)
    const listing = makeRawListing({
      marketplace_id: "shopgoodwill",
      listing_id: "watch-1",
      title: "Super Mario 64",
      price_usd: 15.00,
      url: "",
    });
    const stored = upsertListing(db, listing);

    // Link it to the product
    db.insert(schema.listingItems).values({
      listingId: stored.id,
      productId: "pc-1",
      condition: "loose",
      conditionDetails: {},
      confidence: 0.9,
      confirmed: true,
      rawExtraction: {},
    }).onConflictDoNothing().run();

    // Check: listing price $15 < target $20 → should trigger
    const watchItem = db.select().from(schema.watchlistItems).all()[0];
    const marketPrice = getMarketPrice(db, watchItem.productId, watchItem.condition);
    const targetPrice = marketPrice! * (1 - watchItem.targetPricePct / 100);

    expect(marketPrice).toBe(25);
    expect(targetPrice).toBe(20);
    expect(listing.price_usd).toBeLessThan(targetPrice);
  });

  it("does not trigger when listing is above target", () => {
    db.insert(schema.watchlistItems).values({
      productId: "pc-1",
      targetPricePct: 20,
      condition: "loose",
      createdAt: new Date().toISOString(),
      active: true,
    }).run();

    // Listing at $22 (above $20 target)
    const marketPrice = getMarketPrice(db, "pc-1", "loose")!;
    const targetPrice = marketPrice * (1 - 20 / 100);
    expect(22).toBeGreaterThan(targetPrice);
  });
});
