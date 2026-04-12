/**
 * evaluateOpportunities — compute profit/margin for a listing against recent
 * market price_points for its resolved product, and persist opportunity rows.
 *
 * Market price = median of recent (≤ N days) price_points for the product
 * from any source OTHER than the listing's own source. Dimensions are matched
 * best-effort: entries whose pricing-axis dimensions match the listing's
 * dimensions are preferred; fallback is the most recent entry of any axis.
 */

import { and, eq, gte, ne, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { opportunities, pricePoints, products } from "@/db/schema";
import type {
  AccumulatedSchema,
  TaxonomyNode,
} from "@/db/repos/TaxonomyRepo";
import type { Opportunity, MetadataValue } from "../types";
import type { FieldValue } from "./validate_fields";
import { generateId } from "../utils";

export interface OpportunityThresholds {
  readonly minProfitUsd: number;
  readonly minMarginPct: number;
  readonly feeRate: number;
  readonly shippingOutUsd: number;
}

const DEFAULT_THRESHOLDS: OpportunityThresholds = Object.freeze({
  minProfitUsd: 25,
  minMarginPct: 0.3,
  feeRate: 0.15,
  shippingOutUsd: 5,
});

const MARKET_WINDOW_DAYS = 30;

export interface EvaluateOpportunitiesInput {
  readonly listingDbId: number;
  readonly listingMarketplaceId: string;
  readonly productId: string;
  readonly listingPrice: number;
  readonly shippingUsd: number;
  readonly node: TaxonomyNode;
  readonly schema: AccumulatedSchema;
  readonly fields: ReadonlyMap<string, FieldValue>;
  readonly thresholds?: Partial<OpportunityThresholds>;
  /** If set, overrides the source-exclusion rule (used by known-product fast path). */
  readonly allowSameSource?: boolean;
}

export async function evaluateOpportunities(
  input: EvaluateOpportunitiesInput,
): Promise<readonly Opportunity[]> {
  const thresholds: OpportunityThresholds = {
    ...DEFAULT_THRESHOLDS,
    ...(input.thresholds ?? {}),
  };

  const dimensions = pricingDimensions(input.fields, input.schema);

  const cutoff = new Date(
    Date.now() - MARKET_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const conds = [
    eq(pricePoints.productId, input.productId),
    gte(pricePoints.recordedAt, cutoff),
  ];
  if (!input.allowSameSource) {
    conds.push(ne(pricePoints.source, input.listingMarketplaceId));
  }

  const rows = await db
    .select({
      priceUsd: pricePoints.priceUsd,
      dimensions: pricePoints.dimensions,
      source: pricePoints.source,
      recordedAt: pricePoints.recordedAt,
      condition: pricePoints.condition,
    })
    .from(pricePoints)
    .where(and(...conds))
    .orderBy(sql`${pricePoints.recordedAt} DESC`)
    .limit(50);

  if (rows.length === 0) return Object.freeze([]);

  const marketPrice = computeMarketPrice(rows, dimensions);
  if (marketPrice <= 0) return Object.freeze([]);

  const cost = input.listingPrice + input.shippingUsd;
  const profit =
    marketPrice * (1 - thresholds.feeRate) -
    cost -
    thresholds.shippingOutUsd;
  const margin = cost > 0 ? profit / cost : 0;

  if (
    profit < thresholds.minProfitUsd ||
    margin < thresholds.minMarginPct
  ) {
    return Object.freeze([]);
  }

  // Look up product title for the Opportunity object.
  const productRow = await db.query.products.findFirst({
    where: eq(products.id, input.productId),
    columns: { title: true },
  });

  const priceDimensions: Readonly<Record<string, MetadataValue>> =
    Object.freeze({ ...dimensions });
  const conditionLabel =
    typeof priceDimensions.condition === "string"
      ? priceDimensions.condition
      : "";

  const opportunity: Opportunity = Object.freeze({
    id: generateId("opp"),
    listingId: String(input.listingDbId),
    productId: input.productId,
    productTitle: productRow?.title ?? "",
    condition: conditionLabel,
    priceDimensions,
    marketPrice,
    cost,
    profit,
    margin,
    flags: Object.freeze({
      auctionMayIncrease: false,
      verifyAuthenticity: margin >= 2.0,
      isLot: false,
    }),
    confidence: 0.9,
    createdAt: Date.now(),
  });

  // Persist: insert-or-update opportunity row.
  const now = new Date().toISOString();
  const existing = await db.query.opportunities.findFirst({
    where: and(
      eq(opportunities.listingId, input.listingDbId),
      eq(opportunities.productId, input.productId),
    ),
    columns: { id: true },
  });
  if (existing) {
    await db
      .update(opportunities)
      .set({
        listingPriceUsd: cost,
        marketPriceUsd: marketPrice,
        marketPriceSource: pickSource(rows),
        marketPriceCondition: conditionLabel,
        profitUsd: Math.round(profit * 100) / 100,
        marginPct: Math.round(margin * 10000) / 10000,
        confidence: opportunity.confidence,
        status: "updated",
      })
      .where(eq(opportunities.id, existing.id));
  } else {
    await db.insert(opportunities).values({
      listingId: input.listingDbId,
      productId: input.productId,
      listingPriceUsd: cost,
      marketPriceUsd: marketPrice,
      marketPriceSource: pickSource(rows),
      marketPriceCondition: conditionLabel,
      profitUsd: Math.round(profit * 100) / 100,
      marginPct: Math.round(margin * 10000) / 10000,
      confidence: opportunity.confidence,
      flags: serializeFlags(opportunity.flags),
      status: "new",
      foundAt: now,
    });
  }

  return Object.freeze([opportunity]);
}

function pricingDimensions(
  fields: ReadonlyMap<string, FieldValue>,
  schema: AccumulatedSchema,
): Record<string, MetadataValue> {
  const out: Record<string, MetadataValue> = {};
  for (const f of schema.fields) {
    if (!f.isPricingAxis) continue;
    const v = fields.get(f.key);
    if (v === undefined) continue;
    out[f.key] = v;
  }
  return out;
}

interface PriceRow {
  readonly priceUsd: number;
  readonly dimensions: unknown;
  readonly source: string;
  readonly recordedAt: string;
  readonly condition: string;
}

function computeMarketPrice(
  rows: readonly PriceRow[],
  dimensions: Record<string, MetadataValue>,
): number {
  const matching: number[] = [];
  const any: number[] = [];
  const dimKeys = Object.keys(dimensions);

  for (const r of rows) {
    any.push(r.priceUsd);
    const rDims = normalizeDims(r.dimensions, r.condition);
    let match = true;
    for (const k of dimKeys) {
      if (rDims[k] !== dimensions[k]) {
        match = false;
        break;
      }
    }
    if (match) matching.push(r.priceUsd);
  }

  const pool = matching.length > 0 ? matching : any;
  if (pool.length === 0) return 0;
  return median(pool);
}

function normalizeDims(
  raw: unknown,
  conditionFallback: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (v !== null && v !== undefined) out[k] = v;
    }
  }
  if (!("condition" in out) && conditionFallback) {
    out.condition = conditionFallback;
  }
  return out;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function pickSource(rows: readonly PriceRow[]): string {
  return rows[0]?.source ?? "unknown";
}

function serializeFlags(flags: Opportunity["flags"]): string[] {
  const result: string[] = [];
  if (flags.auctionMayIncrease) result.push("auction_may_increase");
  if (flags.verifyAuthenticity) result.push("verify_authenticity");
  if (flags.isLot) result.push("is_lot");
  return result;
}
