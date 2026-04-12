/**
 * Streaming K&L scan — adapter.stream() piped through the new
 * async-generator pipeline. Scraping happens concurrently with
 * classification; the LLM starts work on page-1 listings while the scraper
 * is still clicking through later pages.
 */

import { KlwinesAdapter } from "@/sources/klwines";
import { runPipeline } from "@/pipeline/stream/pipeline";
import { buildLlm } from "@/scanner/helpers";

async function main() {
  const adapter = new KlwinesAdapter();
  const llm = buildLlm({
    provider: "ollama",
    base_url: process.env.OLLAMA_URL ?? "http://battleaxe:11434",
    model: process.env.OLLAMA_MODEL ?? "qwen3:8b",
  });

  const t0 = Date.now();
  const result = await runPipeline({
    source: adapter.stream(""),
    llm: llm ?? undefined,
    thresholds: {
      minProfitUsd: 25,
      minMarginPct: 0.3,
      feeRate: 0.15,
      shippingOutUsd: 5,
    },
    ollamaUrl: process.env.OLLAMA_URL ?? "http://battleaxe:11434",
  });
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  console.log("\n═══ STREAM SCAN DONE ═══");
  console.log(`elapsed: ${elapsed}s`);
  console.log(`total items: ${result.total}`);
  console.log(`  fast-path: ${result.fastPath}`);
  console.log(`  full-walk: ${result.fullWalk}`);
  console.log(`  errored:   ${result.errored}`);
  console.log(`opportunities found: ${result.opportunitiesFound}`);
  if (result.errorsByStage.size > 0) {
    console.log("errors by stage:");
    for (const [stage, n] of result.errorsByStage) {
      console.log(`  ${stage}: ${n}`);
    }
  }

  await adapter.close();
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
