/**
 * Shared helper utilities for the scanner pipeline.
 */

import { eq, desc, and } from "drizzle-orm";
import { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "../db/schema";
import {
  listings,
  pricePoints,
  scanLogs,
} from "../db/schema";
import type { RawListing } from "../sources/IMarketplaceAdapter";
import { log } from "@/lib/logger";
import { cachedFetch } from "@/lib/cached_fetch";

export type Db = PostgresJsDatabase<typeof schema>;

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

export async function upsertListing(
  db: Db,
  listing: RawListing,
  isLot = false,
): Promise<typeof listings.$inferSelect> {
  const now = new Date().toISOString();

  const existing = (await db
    .select()
    .from(listings)
    .where(
      and(
        eq(listings.marketplaceId, listing.marketplace_id),
        eq(listings.marketplaceListingId, listing.listing_id),
      ),
    )
    .limit(1))[0];

  if (existing) {
    log("helpers", `listing upsert: UPDATE id=${existing.id} [${listing.marketplace_id}/${listing.listing_id}] price=$${listing.price_usd.toFixed(2)}`);
    await db.update(listings)
      .set({
        title: listing.title,
        url: listing.url ?? existing.url,
        description: listing.description ?? existing.description,
        seller: listing.seller ?? existing.seller,
        isLot: isLot || existing.isLot,
        priceUsd: listing.price_usd,
        shippingUsd: listing.shipping_usd ?? 0,
        lastSeenAt: now,
        isActive: true,
      })
      .where(eq(listings.id, existing.id));
    return {
      ...existing,
      title: listing.title,
      url: listing.url ?? existing.url,
      description: listing.description ?? existing.description,
      seller: listing.seller ?? existing.seller,
      isLot: isLot || existing.isLot,
      priceUsd: listing.price_usd,
      shippingUsd: listing.shipping_usd ?? 0,
      lastSeenAt: now,
      isActive: true,
    };
  }

  const inserted = (await db
    .insert(listings)
    .values({
      marketplaceId: listing.marketplace_id,
      marketplaceListingId: listing.listing_id,
      url: listing.url ?? null,
      title: listing.title,
      priceUsd: listing.price_usd,
      shippingUsd: listing.shipping_usd ?? 0,
      seller: listing.seller ?? null,
      isLot,
      firstSeenAt: now,
      lastSeenAt: now,
      isActive: true,
    })
    .returning())[0];

  log("helpers", `listing upsert: INSERT id=${inserted.id} [${listing.marketplace_id}/${listing.listing_id}]${isLot ? " [lot]" : ""} price=$${listing.price_usd.toFixed(2)}`);
  return inserted;
}

// ── Market price lookup ───────────────────────────────────────────────

/**
 * Get the latest PricePoint for a product+condition.
 * Falls back to 'loose' if the requested condition has no price.
 */
export async function getMarketPrice(
  db: Db,
  productId: string,
  condition: string,
): Promise<number | null> {
  const row = (await db
    .select({ priceUsd: pricePoints.priceUsd })
    .from(pricePoints)
    .where(
      and(
        eq(pricePoints.productId, productId),
        eq(pricePoints.condition, condition),
      ),
    )
    .orderBy(desc(pricePoints.recordedAt))
    .limit(1))[0];

  if (row) {
    log("helpers", `market price: product=${productId} condition=${condition} price=$${row.priceUsd.toFixed(2)}`);
    return row.priceUsd;
  }

  // Fall back to loose
  if (condition !== "loose") {
    const fallback = (await db
      .select({ priceUsd: pricePoints.priceUsd })
      .from(pricePoints)
      .where(
        and(
          eq(pricePoints.productId, productId),
          eq(pricePoints.condition, "loose"),
        ),
      )
      .orderBy(desc(pricePoints.recordedAt))
      .limit(1))[0];

    if (fallback) {
      log("helpers", `market price: product=${productId} condition=${condition} not found, fallback loose=$${fallback.priceUsd.toFixed(2)}`);
    } else {
      log("helpers", `market price: product=${productId} no price found for ${condition} or loose`);
    }
    return fallback?.priceUsd ?? null;
  }

  log("helpers", `market price: product=${productId} condition=loose not found`);
  return null;
}

// ── Scan log ──────────────────────────────────────────────────────────

export async function startScanLog(db: Db, marketplaceId: string): Promise<number> {
  const row = (await db
    .insert(scanLogs)
    .values({
      marketplaceId,
      startedAt: new Date().toISOString(),
      queriesRun: 0,
      listingsFound: 0,
      opportunitiesFound: 0,
      rateLimited: false,
    })
    .returning({ id: scanLogs.id }))[0];
  return row.id;
}

export async function finishScanLog(
  db: Db,
  scanLogId: number,
  queriesRun: number,
  listingsFound: number,
  opportunitiesFound: number,
  rateLimited: boolean,
): Promise<void> {
  await db.update(scanLogs)
    .set({
      finishedAt: new Date().toISOString(),
      queriesRun,
      listingsFound,
      opportunitiesFound,
      rateLimited,
    })
    .where(eq(scanLogs.id, scanLogId));
}

// ── LLM factory ───────────────────────────────────────────────────────

export { type LlmClient } from "@/llm/pool";
import type { LlmClient } from "@/llm/pool";
import {
  LlmPool,
  ollamaProvider,
  openRouterProvider,
  type LlmProviderConfig,
} from "@/llm/pool";

/**
 * Build the LLM pool from the normalizer config. The pool aggregates
 * every configured provider (Ollama + OpenRouter free models, etc.) and
 * routes each call to the least-busy one. Concurrency = number of
 * providers; the pipeline stages scale parallelMap accordingly.
 */
export function buildLlm(normCfg: Record<string, unknown>): LlmClient | null {
  if (normCfg["provider"] !== "ollama") return null;

  const providers: LlmProviderConfig[] = [
    ollamaProvider({
      baseUrl: (normCfg["base_url"] as string) ?? process.env.OLLAMA_URL,
      model: (normCfg["model"] as string) ?? process.env.OLLAMA_MODEL,
    }),
  ];

  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    const models = (process.env.OPENROUTER_MODELS ?? "openai/gpt-oss-120b,openai/gpt-oss-20b")
      .split(",").map((m) => m.trim()).filter(Boolean);
    // Fan out to N distinct mutex slots per model so paid-tier parallelism
    // isn't collapsed into one lane by a shared serializeKey. Default 10.
    const parallelPerModel = Math.max(1, parseInt(process.env.OPENROUTER_PARALLEL ?? "10", 10));
    for (const m of models) {
      for (let slot = 0; slot < parallelPerModel; slot++) {
        providers.push(
          openRouterProvider({
            apiKey: orKey,
            model: m,
            name: `openrouter:${m}#${slot}`,
            serializeKey: `openrouter:${m}:${slot}`,
          }),
        );
      }
    }
  }

  return new LlmPool(providers);
}
