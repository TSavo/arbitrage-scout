/**
 * Streaming pipeline composer.
 *
 * Every stage is a pure `async function*` transform — pull an item, maybe
 * do work, yield an item. The composer puts a **FIFO buffer between every
 * stage boundary** so that upstream yields never block on downstream. The
 * buffer eagerly pulls every item upstream yields and holds them until
 * downstream is ready. That's the whole mechanism behind pipeline-stage
 * concurrency: scraping keeps running while classify is busy on earlier
 * items, and every stage makes progress independently.
 *
 * Buffers are unbounded by default — the memory for 3000-odd PipelineItem
 * records is trivial compared to keeping LLM calls from stalling upstream.
 * Set `bufferSize` if you want backpressure.
 */

import type { RawListing as AdapterRawListing } from "@/sources/IMarketplaceAdapter";
import {
  validateStage,
  detectTierStage,
  fastPathStage,
  extractStage,
  classifyStage,
  heavyTailStage,
  drain,
  type StageConfig,
  type PipelineSinkResult,
} from "./stages";
import { makeItem, fromAdapterListing, type PipelineItem } from "./types";
import { buffer } from "./parallel";

const DEFAULT_BUFFER = Number.POSITIVE_INFINITY;

export interface RunPipelineArgs extends StageConfig {
  readonly source: AsyncIterable<AdapterRawListing>;
  /** FIFO buffer size between each stage. Infinite = upstream never blocks. */
  readonly bufferSize?: number;
}

export async function runPipeline(
  args: RunPipelineArgs,
): Promise<PipelineSinkResult> {
  const { source, bufferSize, ...config } = args;
  const size = bufferSize ?? DEFAULT_BUFFER;

  // Compose: every hop wrapped in buffer(...) so yields never stall.
  let s: AsyncIterable<PipelineItem> = buffer(toItems(source), size);
  s = buffer(validateStage(s), size);
  s = buffer(detectTierStage(s), size);
  s = buffer(fastPathStage(s, config), size);
  s = buffer(extractStage(s, config), size);
  s = buffer(classifyStage(s, config), size);
  s = buffer(heavyTailStage(s, config), size);

  return drain(s);
}

async function* toItems(
  source: AsyncIterable<AdapterRawListing>,
): AsyncIterable<PipelineItem> {
  for await (const raw of source) {
    yield makeItem(fromAdapterListing(raw));
  }
}
