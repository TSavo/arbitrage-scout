import type { CatalogMatch, MetadataValue } from '../types';
import { db } from '@/db/client';
import { pricePoints } from '@/db/schema';
import { eq, desc } from 'drizzle-orm';

export type PriceDimensions = Readonly<Record<string, MetadataValue>>;

export interface PriceInput {
  readonly matches: ReadonlyMap<number, CatalogMatch | null>;
  /** Pricing dimensions per item index (from the item's pricing-axis metadata). */
  readonly dimensions?: ReadonlyMap<number, PriceDimensions>;
}

export interface PriceOutput {
  /** Keyed by productId. */
  readonly prices: ReadonlyMap<string, PriceData>;
  readonly foundCount: number;
  readonly missingCount: number;
  readonly pricedAt: number;
}

/**
 * Price point list for a product. Callers pick the right entry via dimensions.
 * The legacy `loose`/`cib`/... accessors are kept for back-compat with the
 * evaluate command's `getBestPrice` and external UI consumers.
 */
export interface PriceData {
  readonly entries: readonly PricePointEntry[];
  readonly source: string;
  readonly recordedAt: string;
  // Legacy convenience accessors — populated when a `condition` key is used.
  readonly loose?: number;
  readonly cib?: number;
  readonly new_sealed?: number;
  readonly graded?: number;
  readonly box_only?: number;
  readonly manual_only?: number;
}

export interface PricePointEntry {
  readonly priceUsd: number;
  readonly dimensions: PriceDimensions;
  readonly source: string;
  readonly recordedAt: string;
}

export type PriceCommand = {
  readonly id: string;
  readonly type: 'price';
  readonly input: PriceInput;
  readonly output: PriceOutput;
  readonly timestamp: number;
  readonly durationMs: number;
};

const PRICE_CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, { data: PriceData; expiresAt: number }>();

export async function lookupPrices(input: PriceInput): Promise<PriceOutput> {
  const start = Date.now();
  const prices = new Map<string, PriceData>();
  let foundCount = 0;
  let missingCount = 0;

  const now = Date.now();

  for (const [, match] of input.matches) {
    if (!match) continue;

    const cacheKey = match.productId;
    const cached = cache.get(cacheKey);

    if (cached && cached.expiresAt > now) {
      prices.set(cacheKey, cached.data);
      foundCount++;
      continue;
    }

    const price = await fetchPrice(match.productId);

    if (price) {
      prices.set(cacheKey, price);
      cache.set(cacheKey, { data: price, expiresAt: now + PRICE_CACHE_TTL_MS });
      foundCount++;
    } else {
      missingCount++;
    }
  }

  return Object.freeze({
    prices: prices as ReadonlyMap<string, PriceData>,
    foundCount,
    missingCount,
    pricedAt: start,
  });
}

async function fetchPrice(productId: string): Promise<PriceData | null> {
  try {
    const rows = await db
      .select({
        condition: pricePoints.condition,
        dimensions: pricePoints.dimensions,
        priceUsd: pricePoints.priceUsd,
        source: pricePoints.source,
        recordedAt: pricePoints.recordedAt,
      })
      .from(pricePoints)
      .where(eq(pricePoints.productId, productId))
      .orderBy(desc(pricePoints.recordedAt))
      .limit(25)
      .all();

    if (rows.length === 0) return null;

    const entries: PricePointEntry[] = rows.map((row) => {
      const dims = normalizeDimensions(row.dimensions, row.condition);
      return Object.freeze({
        priceUsd: row.priceUsd,
        dimensions: Object.freeze(dims),
        source: row.source,
        recordedAt: row.recordedAt,
      });
    });

    // Legacy accessors: first price found per condition key wins (rows are
    // already ordered by recordedAt desc).
    const legacy: Record<string, number> = {};
    for (const e of entries) {
      const cond = e.dimensions.condition;
      if (typeof cond === 'string' && legacy[cond] === undefined) {
        legacy[cond] = e.priceUsd;
      }
    }

    return Object.freeze({
      entries: Object.freeze(entries),
      source: rows[0].source,
      recordedAt: rows[0].recordedAt,
      ...legacy,
    }) as PriceData;
  } catch {
    return null;
  }
}

function normalizeDimensions(
  raw: unknown,
  conditionFallback: string,
): Record<string, MetadataValue> {
  const out: Record<string, MetadataValue> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v === null || v === undefined) continue;
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        out[k] = v;
      } else {
        out[k] = String(v);
      }
    }
  }
  if (!('condition' in out) && conditionFallback) {
    out.condition = conditionFallback;
  }
  return out;
}

/** Best-match price for a given set of pricing dimensions. */
export function getMarketPrice(prices: PriceData, dimensions?: PriceDimensions): number {
  if (!prices.entries.length) return 0;

  if (dimensions && Object.keys(dimensions).length > 0) {
    // Prefer exact multi-axis match; fall back to best partial match.
    let bestScore = -1;
    let bestPrice = 0;
    for (const e of prices.entries) {
      let score = 0;
      let mismatched = false;
      for (const [k, v] of Object.entries(dimensions)) {
        if (e.dimensions[k] === v) score++;
        else if (e.dimensions[k] !== undefined) { mismatched = true; break; }
      }
      if (mismatched) continue;
      if (score > bestScore) {
        bestScore = score;
        bestPrice = e.priceUsd;
      }
    }
    if (bestPrice > 0) return bestPrice;
  }

  // Legacy condition priority ordering for single-axis types.
  const priority = ['graded', 'new_sealed', 'cib', 'loose', 'in_box', 'raw', 'box_only', 'manual_only'];
  for (const cond of priority) {
    const match = prices.entries.find((e) => e.dimensions.condition === cond);
    if (match) return match.priceUsd;
  }

  // No pricing axes at all (e.g. bourbon): first entry is the price.
  return prices.entries[0].priceUsd;
}
