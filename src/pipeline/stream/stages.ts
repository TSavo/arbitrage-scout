/**
 * Pipeline stages as pure async-generator transforms.
 *
 * Each stage = `async function*(source): yield items`. No concurrency or
 * buffering machinery lives here — the pipeline composer wraps each stage
 * with a `buffer()` between stages, which is what enables different stages
 * to run concurrently on different items. Stages themselves are just
 * "pull an item, maybe do work, yield an item".
 *
 * Conventions:
 * - If `item.error` is set by an upstream stage, pass through untouched.
 * - If the stage doesn't apply to this item (fast-path skipping classify),
 *   mark it as skipped and pass through.
 * - On new failure, set `error` on a copy and yield it — downstream stages
 *   see the error and pass through without work. The pipeline never halts.
 */

import type { LlmClient } from "@/llm/pool";
import { validate } from "@/pipeline/commands/validate";
import { detectTier } from "@/pipeline/commands/detect_tier";
import { extractUnconstrained } from "@/pipeline/commands/extract_unconstrained";
import { classify } from "@/pipeline/commands/classify";
import { validateFields } from "@/pipeline/commands/validate_fields";
import { resolveIdentity } from "@/pipeline/commands/resolve_identity";
import { persist } from "@/pipeline/commands/persist";
import { writePricePoint } from "@/pipeline/commands/write_price_point";
import {
  evaluateOpportunities,
  type OpportunityThresholds,
} from "@/pipeline/commands/evaluate_opportunities";
import { processKnownProduct } from "@/pipeline/commands/process_known";
import { processCachedListing } from "@/pipeline/commands/process_cached";
import { taxonomyRepo } from "@/db/repos/TaxonomyRepo";
import { log, error as logError } from "@/lib/logger";
import { parallelMap } from "./parallel";
import {
  type PipelineItem,
  withError,
  withSkip,
  withStageResult,
} from "./types";

export interface StageConfig {
  readonly llm?: LlmClient;
  readonly thresholds: OpportunityThresholds;
  readonly ollamaUrl: string;
  /**
   * How many LLM stage workers to run in parallel. Set to the size of the
   * LLM provider pool — each worker picks a free provider, so N providers
   * = N concurrent classify/extract operations.
   */
  readonly llmConcurrency?: number;
}

function wasFastPathed(item: PipelineItem): boolean {
  return item.tier?.kind === "external_id" || item.tier?.kind === "cached";
}

/**
 * Wrap an async stage body so we log slow items (≥SLOW_LOG_MS) as they happen.
 * Keeps the log volume manageable by only emitting lines for the tail of the
 * latency distribution — every classify that takes >10s shows up.
 */
const SLOW_LOG_MS = 10_000;
async function timed<T extends PipelineItem>(
  stage: string,
  item: T,
  body: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  const out = await body();
  const elapsed = Date.now() - t0;
  if (elapsed >= SLOW_LOG_MS) {
    log(
      "pipeline",
      `SLOW ${stage} id=${item.id} elapsed=${elapsed}ms errored=${!!out.error}`,
    );
  }
  return out;
}

// ── stages ────────────────────────────────────────────────────────────────

export async function* validateStage(
  source: AsyncIterable<PipelineItem>,
): AsyncIterable<PipelineItem> {
  for await (const item of source) {
    if (item.error) { yield item; continue; }
    yield await timed("validate", item, async () => {
      try {
        const result = validate({ listing: item.listing });
        if (!result.isValid) {
          return withError(
            item,
            "validate",
            new Error(result.errors.join("; ") || "invalid listing"),
          );
        }
        return withStageResult(item, "validate", "validated", result.listing);
      } catch (err) {
        return withError(item, "validate", err);
      }
    });
  }
}

export async function* detectTierStage(
  source: AsyncIterable<PipelineItem>,
): AsyncIterable<PipelineItem> {
  for await (const item of source) {
    if (item.error) { yield item; continue; }
    if (!item.validated) {
      yield withError(item, "detect_tier", new Error("not validated"));
      continue;
    }
    yield await timed("detect_tier", item, async () => {
      try {
        const tier = await detectTier(item.validated!);
        return withStageResult(item, "detect_tier", "tier", tier);
      } catch (err) {
        return withError(item, "detect_tier", err);
      }
    });
  }
}

export async function* fastPathStage(
  source: AsyncIterable<PipelineItem>,
  config: StageConfig,
): AsyncIterable<PipelineItem> {
  for await (const item of source) {
    if (item.error) { yield item; continue; }
    if (!item.validated || !item.tier) { yield item; continue; }
    const tier = item.tier;
    const validated = item.validated;

    try {
      if (tier.kind === "external_id") {
        const result = await processKnownProduct({
          listing: validated,
          productId: tier.productId,
          thresholds: config.thresholds,
          ollamaUrl: config.ollamaUrl,
        });
        yield withStageResult(
          withSkip(withSkip(withSkip(item, "extract"), "classify"), "heavy_tail"),
          "fast_path",
          "opportunitiesFound",
          result.opportunities.length,
        );
        continue;
      }
      if (tier.kind === "cached") {
        const result = await processCachedListing({
          listing: validated,
          existingListingId: tier.existingListingId,
          productIds: tier.productIds,
          thresholds: config.thresholds,
        });
        yield withStageResult(
          withSkip(withSkip(withSkip(item, "extract"), "classify"), "heavy_tail"),
          "fast_path",
          "opportunitiesFound",
          result.opportunities.length,
        );
        continue;
      }
      yield item; // full_walk falls through to heavy stages
    } catch (err) {
      yield withError(item, "fast_path", err);
    }
  }
}

export function extractStage(
  source: AsyncIterable<PipelineItem>,
  config: StageConfig,
): AsyncIterable<PipelineItem> {
  // parallelMap with N workers — each worker calls llmPool.generateJson,
  // which picks a free provider. N providers ⇒ N concurrent extracts.
  return parallelMap(
    source,
    (item) => extractOne(item, config),
    { concurrency: Math.max(1, config.llmConcurrency ?? 1) },
  );
}

async function extractOne(item: PipelineItem, config: StageConfig): Promise<PipelineItem> {
  if (item.error) return item;
  if (wasFastPathed(item)) return withSkip(item, "extract");
  if (!item.validated) return withError(item, "extract", new Error("not validated"));
  return timed("extract", item, async () => {
    try {
      const extracted = await extractUnconstrained({
        listing: item.validated!,
        llmClient: config.llm,
      });
      return withStageResult(item, "extract", "extracted", extracted);
    } catch (err) {
      return withError(item, "extract", err);
    }
  });
}

export function classifyStage(
  source: AsyncIterable<PipelineItem>,
  config: StageConfig,
): AsyncIterable<PipelineItem> {
  return parallelMap(
    source,
    (item) => classifyOne(item, config),
    { concurrency: Math.max(1, config.llmConcurrency ?? 1) },
  );
}

async function classifyOne(item: PipelineItem, config: StageConfig): Promise<PipelineItem> {
  if (item.error) return item;
  if (wasFastPathed(item)) return withSkip(item, "classify");
  if (!item.extracted || !item.validated) {
    return withError(item, "classify", new Error("missing prior stage output"));
  }
  return timed("classify", item, async () => {
    try {
      const classified = await classify({
        listing: item.validated!,
        extractedFields: item.extracted!.fields,
        llmClient: config.llm,
      });
      return withStageResult(item, "classify", "classified", classified);
    } catch (err) {
      return withError(item, "classify", err);
    }
  });
}

/**
 * Heavy tail — validateFields + resolveIdentity + persist + pricePoint +
 * evaluate. These serialize naturally per item (each step consumes the
 * previous step's output), but different items can be at different stages
 * of the pipeline concurrently.
 */
export async function* heavyTailStage(
  source: AsyncIterable<PipelineItem>,
  config: StageConfig,
): AsyncIterable<PipelineItem> {
  for await (const item of source) {
    if (item.error) { yield item; continue; }
    if (wasFastPathed(item)) { yield item; continue; }
    if (!item.extracted || !item.classified || !item.validated) {
      yield withError(item, "heavy_tail", new Error("missing prior stage output"));
      continue;
    }
    yield await timed("heavy_tail", item, async () => {
      try {
        const listing = item.validated!;
        const cls = item.classified!;
        const leaf = cls.path[cls.path.length - 1];

        const validatedFields = validateFields({
          extracted: item.extracted!.fields,
          schema: cls.accumulatedSchema,
        });

        const identity = await resolveIdentity({
          listing,
          fields: validatedFields.values,
          node: leaf,
          schema: cls.accumulatedSchema,
          ollamaUrl: config.ollamaUrl,
        });

        const schemaVersion = await taxonomyRepo.getCurrentSchemaVersion();
        const stored = await persist({
          listing,
          product: identity,
          fields: validatedFields.values,
          nodeId: leaf.id,
          schemaVersion,
          ollamaUrl: config.ollamaUrl,
          confirmed: identity.method !== "new",
        });

        await writePricePoint({
          productId: stored.productId,
          source: listing.marketplaceId,
          priceUsd: listing.priceUsd,
          fields: validatedFields.values,
          schema: cls.accumulatedSchema,
        });

        const opps = await evaluateOpportunities({
          listingDbId: stored.listingId,
          listingMarketplaceId: listing.marketplaceId,
          productId: stored.productId,
          listingPrice: listing.priceUsd,
          shippingUsd: listing.shippingUsd,
          node: leaf,
          schema: cls.accumulatedSchema,
          fields: validatedFields.values,
          thresholds: config.thresholds,
        });

        return withStageResult(
          withStageResult(item, "persist", "persisted", stored),
          "evaluate",
          "opportunitiesFound",
          opps.length,
        );
      } catch (err) {
        return withError(item, "heavy_tail", err);
      }
    });
  }
}

// ── sink / logger ──────────────────────────────────────────────────────────

export interface PipelineSinkResult {
  readonly total: number;
  readonly errored: number;
  readonly fastPath: number;
  readonly fullWalk: number;
  readonly opportunitiesFound: number;
  readonly errorsByStage: ReadonlyMap<string, number>;
}

export async function drain(
  stream: AsyncIterable<PipelineItem>,
): Promise<PipelineSinkResult> {
  let total = 0;
  let errored = 0;
  let fastPath = 0;
  let fullWalk = 0;
  let opportunitiesFound = 0;
  const errorsByStage = new Map<string, number>();
  const startedAt = Date.now();
  let lastItemAt = Date.now();
  let lastHeartbeatTotal = 0;

  // Heartbeat — every 15s log the state of the pipeline. If total hasn't
  // advanced since the last beat, flag it as stalled so we notice when an
  // upstream stage hangs without errors.
  const heartbeat = setInterval(() => {
    const now = Date.now();
    const elapsedS = ((now - startedAt) / 1000).toFixed(0);
    const idleS = ((now - lastItemAt) / 1000).toFixed(0);
    const deltaSinceLastBeat = total - lastHeartbeatTotal;
    lastHeartbeatTotal = total;
    const rate = total / Math.max(1, (now - startedAt) / 60_000);
    const tag = deltaSinceLastBeat === 0 ? "HEARTBEAT STALLED" : "HEARTBEAT";
    log(
      "pipeline",
      `${tag} elapsed=${elapsedS}s total=${total} (+${deltaSinceLastBeat}) rate=${rate.toFixed(1)}/min lastItem=${idleS}s ago fastPath=${fastPath} fullWalk=${fullWalk} errored=${errored} opps=${opportunitiesFound}`,
    );
  }, 15_000);

  try {
    for await (const item of stream) {
      total++;
      lastItemAt = Date.now();
      if (item.error) {
        errored++;
        errorsByStage.set(item.error.stage, (errorsByStage.get(item.error.stage) ?? 0) + 1);
        logError(
          "pipeline",
          `${item.id} failed at ${item.error.stage}: ${item.error.message}`,
        );
        continue;
      }
      if (wasFastPathed(item)) fastPath++;
      else fullWalk++;
      opportunitiesFound += item.opportunitiesFound ?? 0;

      if (total % 25 === 0) {
        log(
          "pipeline",
          `progress: total=${total} fastPath=${fastPath} fullWalk=${fullWalk} errored=${errored} opps=${opportunitiesFound}`,
        );
      }
    }
  } finally {
    clearInterval(heartbeat);
  }

  return Object.freeze({
    total,
    errored,
    fastPath,
    fullWalk,
    opportunitiesFound,
    errorsByStage,
  });
}
