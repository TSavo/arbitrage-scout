/**
 * PipelineItem — the single accumulating state object that flows through
 * every stage of the streaming pipeline.
 *
 * Each stage consumes upstream items, attaches its result to a new immutable
 * copy, and yields it downstream. Any stage can set `error` to short-circuit
 * the rest of the pipeline for that item — subsequent stages must skip work
 * but still pass the item through so the final consumer can log/count it.
 *
 * The `skipped` set records which stages were bypassed (typically by tier-1
 * or tier-2 fast paths that don't need classify/extract/match).
 */

import type { RawListing as AdapterRawListing } from "@/sources/IMarketplaceAdapter";
import type { RawListing, ValidatedListing } from "@/pipeline/types";
import type { TierDetection } from "@/pipeline/commands/detect_tier";
import type { UnconstrainedExtractResult } from "@/pipeline/commands/extract_unconstrained";
import type { ClassifyResult } from "@/pipeline/commands/classify";
import type { IdentityResolution } from "@/pipeline/commands/resolve_identity";
import type { PersistResult } from "@/pipeline/commands/persist";

export interface PipelineItemError {
  readonly stage: string;
  readonly message: string;
  readonly cause?: unknown;
}

export interface PipelineItem {
  /** Stable id for correlation across events. `${marketplace_id}:${listing_id}`. */
  readonly id: string;
  /** Pipeline-shape (camelCase) listing. Adapters emit the snake_case shape;
   *  `toItems()` converts upfront so every stage sees the same shape. */
  readonly listing: RawListing;
  /** After the validate stage populates it. */
  readonly validated?: ValidatedListing;

  // Stage outputs — optional; filled in as the item flows downstream.
  readonly tier?: TierDetection;
  readonly extracted?: UnconstrainedExtractResult;
  readonly classified?: ClassifyResult;
  readonly identity?: IdentityResolution;
  readonly persisted?: PersistResult;
  readonly opportunitiesFound?: number;

  /** Names of stages that legitimately skipped this item (tier-1/2 fast path). */
  readonly skipped?: readonly string[];

  /** Set by any stage that fails. Downstream stages pass through without work. */
  readonly error?: PipelineItemError;

  /** Wall-clock millis at each stage boundary, for profiling. */
  readonly timings: Readonly<Record<string, number>>;
}

export function makeItem(listing: RawListing): PipelineItem {
  return Object.freeze({
    id: `${listing.marketplaceId}:${listing.listingId}`,
    listing,
    timings: Object.freeze({ ingress: Date.now() }),
  });
}

export function fromAdapterListing(raw: AdapterRawListing): RawListing {
  return {
    marketplaceId: raw.marketplace_id,
    listingId: raw.listing_id,
    title: raw.title,
    priceUsd: raw.price_usd,
    shippingUsd: raw.shipping_usd ?? 0,
    url: raw.url ?? "",
    description: raw.description,
    conditionRaw: raw.condition_raw,
    categoryRaw: raw.category_raw,
    imageUrl: raw.image_url,
    seller: raw.seller,
    numBids: raw.num_bids,
    itemCount: raw.item_count,
    endTime: raw.end_time,
    extra: raw.extra,
    scrapedAt: Date.now(),
  };
}

export function withError(
  item: PipelineItem,
  stage: string,
  cause: unknown,
): PipelineItem {
  const message = cause instanceof Error ? cause.message : String(cause);
  return Object.freeze({
    ...item,
    error: Object.freeze({ stage, message, cause }),
    timings: Object.freeze({ ...item.timings, [stage]: Date.now() }),
  });
}

export function withSkip(item: PipelineItem, stage: string): PipelineItem {
  const skipped = Object.freeze([...(item.skipped ?? []), stage]);
  return Object.freeze({
    ...item,
    skipped,
    timings: Object.freeze({ ...item.timings, [stage]: Date.now() }),
  });
}

export function withStageResult<K extends keyof PipelineItem>(
  item: PipelineItem,
  stage: string,
  key: K,
  value: PipelineItem[K],
): PipelineItem {
  return Object.freeze({
    ...item,
    [key]: value,
    timings: Object.freeze({ ...item.timings, [stage]: Date.now() }),
  });
}
