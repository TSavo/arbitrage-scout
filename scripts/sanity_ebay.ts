/**
 * eBay sanity check — pulls a small handful of listings from one discovery
 * query and pipes them through the new streaming pipeline. Verifies:
 *   - OAuth + Browse API works
 *   - adapter.stream (falls back to search() via searchAsStream)
 *   - Pipeline stages accept eBay RawListings
 *   - No typing/plumbing errors specific to this adapter
 *
 * Does NOT run a full scan. 5 items, bounded.
 */
// Load .env.local manually (no dotenv dep).
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

import { EbayAdapter } from "@/sources/ebay";
import { searchAsStream } from "@/sources/IMarketplaceAdapter";
import { runPipeline } from "@/pipeline/stream/pipeline";
import { buildLlm } from "@/scanner/helpers";

async function main() {
  const appId = process.env.EBAY_APP_ID;
  const certId = process.env.EBAY_CERT_ID;
  if (!appId || !certId) {
    console.error("Missing EBAY_APP_ID / EBAY_CERT_ID");
    process.exit(1);
  }

  const adapter = new EbayAdapter({ app_id: appId, cert_id: certId });
  const llm = buildLlm({
    provider: "ollama",
    base_url: process.env.OLLAMA_URL ?? "http://battleaxe:11434",
    model: process.env.OLLAMA_MODEL ?? "qwen3:8b",
  });

  console.log("fetching 5 listings from eBay…");
  const source = searchAsStream(adapter, "n64 game", { limit: 5 });

  const t0 = Date.now();
  const result = await runPipeline({
    source,
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

  console.log("\n═══ EBAY SANITY ═══");
  console.log(`elapsed: ${elapsed}s`);
  console.log(`total:   ${result.total}`);
  console.log(`fastPath:${result.fastPath}`);
  console.log(`fullWalk:${result.fullWalk}`);
  console.log(`errored: ${result.errored}`);
  console.log(`opps:    ${result.opportunitiesFound}`);
  if (result.errorsByStage.size > 0) {
    for (const [stage, n] of result.errorsByStage) {
      console.log(`  error @${stage}: ${n}`);
    }
  }
  process.exit(result.errored === result.total && result.total > 0 ? 1 : 0);
}

main().catch((e) => { console.error("FAIL:", e); process.exit(2); });
