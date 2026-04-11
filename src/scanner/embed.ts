/**
 * Bulk embed all products that don't have embeddings yet.
 * Batches requests to Ollama for efficiency.
 */

import { db } from "@/db/client";
import { products } from "@/db/schema";
import { embeddingRepo } from "@/db/repos/EmbeddingRepo";
import { log, section, progress } from "@/lib/logger";

export interface EmbedResult {
  total: number;
  embedded: number;
  skipped: number;
  errors: number;
  elapsedMs: number;
}

export async function runEmbed(opts: {
  batchSize?: number;
  ollamaUrl?: string;
} = {}): Promise<EmbedResult> {
  const batchSize = opts.batchSize ?? 50;
  const ollamaUrl = opts.ollamaUrl ?? process.env.OLLAMA_URL ?? "http://battleaxe:11434";

  section("EMBED");

  const allProducts = await db
    .select({ id: products.id, title: products.title, platform: products.platform })
    .from(products);

  const total = allProducts.length;
  const initialCount = await embeddingRepo.count("product");
  let embedded = 0;
  let skipped = 0;
  let errors = 0;
  const t0 = Date.now();

  log("embed", `${total} products | ${initialCount} already embedded`);
  log("embed", `ollama: ${ollamaUrl} | model: qwen3-embedding:8b | batch: ${batchSize}`);

  for (let i = 0; i < total; i += batchSize) {
    const batch = allProducts.slice(i, i + batchSize);
    const items = batch.map((p) => ({
      id: p.id,
      text: `${p.title} ${p.platform || ""}`.trim(),
    }));

    try {
      const newCount = await embeddingRepo.batchEmbed("product", items, ollamaUrl);
      embedded += newCount;
      skipped += items.length - newCount;
    } catch (err) {
      errors++;
      const msg = err instanceof Error ? err.message : String(err);
      log("embed", `ERROR batch ${Math.floor(i / batchSize) + 1}: ${msg}`);
      skipped += items.length;
    }

    const processed = i + batch.length;
    progress(processed, total, "products");

    if (processed % 500 === 0 || processed >= total) {
      const elapsedSec = (Date.now() - t0) / 1000;
      const rate = embedded > 0 ? (embedded / elapsedSec).toFixed(1) : "0";
      const remaining = total - processed;
      const etaMin = embedded > 0 ? Math.round((remaining / (embedded / elapsedSec)) / 60) : "?";
      log("embed", `${processed}/${total} (${Math.round((processed / total) * 100)}%) | +${embedded} new | ${skipped} cached | ${errors} err | ${rate}/s | ETA ${etaMin}m`);
    }
  }

  const elapsedMs = Date.now() - t0;
  const finalCount = await embeddingRepo.count("product");

  section("EMBED COMPLETE");
  log("embed", `new: ${embedded} | cached: ${skipped} | errors: ${errors} | elapsed: ${(elapsedMs / 1000 / 60).toFixed(1)}m`);
  log("embed", `total product embeddings: ${finalCount}`);

  return { total, embedded, skipped, errors, elapsedMs };
}
