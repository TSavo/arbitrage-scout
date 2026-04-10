/**
 * Shared helper utilities for the scanner pipeline.
 */

import { eq, desc, and } from "drizzle-orm";
import { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import {
  listings,
  pricePoints,
  scanLogs,
} from "../db/schema";
import type { RawListing } from "../sources/base_marketplace";
import type { OllamaClient } from "../llm/ollama";

export type Db = BetterSQLite3Database<typeof schema>;

// ── Config helpers ────────────────────────────────────────────────────

export function cfg<T>(
  config: Record<string, unknown>,
  section: string,
  key: string,
  defaultValue: T,
): T {
  const sec = config[section];
  if (sec && typeof sec === "object" && !Array.isArray(sec)) {
    const val = (sec as Record<string, unknown>)[key];
    if (val !== undefined) return val as T;
  }
  return defaultValue;
}

// ── Listing upsert ────────────────────────────────────────────────────

export function upsertListing(
  db: Db,
  listing: RawListing,
  isLot = false,
): typeof listings.$inferSelect {
  const now = new Date().toISOString();

  const existing = db
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.marketplaceId, listing.marketplaceId),
        eq(listings.marketplaceListingId, listing.listingId),
      ),
    )
    .limit(1)
    .all()[0];

  if (existing) {
    db.update(listings)
      .set({
        priceUsd: listing.priceUsd,
        shippingUsd: listing.shippingUsd ?? 0,
        lastSeenAt: now,
        isActive: true,
      })
      .where(eq(listings.id, existing.id))
      .run();
    return { ...existing, priceUsd: listing.priceUsd, shippingUsd: listing.shippingUsd ?? 0, lastSeenAt: now, isActive: true };
  }

  const inserted = db
    .insert(listings)
    .values({
      marketplaceId: listing.marketplaceId,
      marketplaceListingId: listing.listingId,
      url: listing.url ?? null,
      title: listing.title,
      priceUsd: listing.priceUsd,
      shippingUsd: listing.shippingUsd ?? 0,
      seller: listing.seller ?? null,
      isLot,
      firstSeenAt: now,
      lastSeenAt: now,
      isActive: true,
    })
    .returning()
    .get();

  return inserted;
}

// ── Market price lookup ───────────────────────────────────────────────

/**
 * Get the latest PricePoint for a product+condition.
 * Falls back to 'loose' if the requested condition has no price.
 */
export function getMarketPrice(
  db: Db,
  productId: string,
  condition: string,
): number | null {
  const row = db
    .select({ priceUsd: pricePoints.priceUsd })
    .from(pricePoints)
    .where(
      and(
        eq(pricePoints.productId, productId),
        eq(pricePoints.condition, condition),
      ),
    )
    .orderBy(desc(pricePoints.recordedAt))
    .limit(1)
    .all()[0];

  if (row) return row.priceUsd;

  // Fall back to loose
  if (condition !== "loose") {
    const fallback = db
      .select({ priceUsd: pricePoints.priceUsd })
      .from(pricePoints)
      .where(
        and(
          eq(pricePoints.productId, productId),
          eq(pricePoints.condition, "loose"),
        ),
      )
      .orderBy(desc(pricePoints.recordedAt))
      .limit(1)
      .all()[0];

    return fallback?.priceUsd ?? null;
  }

  return null;
}

// ── Scan log ──────────────────────────────────────────────────────────

export function startScanLog(db: Db, marketplaceId: string): number {
  const row = db
    .insert(scanLogs)
    .values({
      marketplaceId,
      startedAt: new Date().toISOString(),
      queriesRun: 0,
      listingsFound: 0,
      opportunitiesFound: 0,
      rateLimited: false,
    })
    .returning({ id: scanLogs.id })
    .get();
  return row.id;
}

export function finishScanLog(
  db: Db,
  scanLogId: number,
  queriesRun: number,
  listingsFound: number,
  opportunitiesFound: number,
  rateLimited: boolean,
): void {
  db.update(scanLogs)
    .set({
      finishedAt: new Date().toISOString(),
      queriesRun,
      listingsFound,
      opportunitiesFound,
      rateLimited,
    })
    .where(eq(scanLogs.id, scanLogId))
    .run();
}

// ── LLM factory ───────────────────────────────────────────────────────

export function buildLlm(
  normCfg: Record<string, unknown>,
): OllamaClient | null {
  if (normCfg["provider"] !== "ollama") return null;
  // Lazy import to avoid hard dep when not needed
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { OllamaClient: OC } = require("../llm/ollama") as { OllamaClient: new (opts: Record<string, unknown>) => OllamaClient };
  return new OC({
    baseUrl: (normCfg["base_url"] as string) ?? "http://battleaxe:11434",
    model: (normCfg["model"] as string) ?? "qwen3:8b",
    think: (normCfg["think"] as boolean) ?? false,
  });
}
