/**
 * Run a focused scan against just K&L. No eBay, no other adapters.
 * Assumes Chrome is on :9222 with the tab on the New Product Feed.
 */
import { runScan } from "@/scanner/scan";
import { KlwinesAdapter } from "@/sources/klwines";

async function main() {
  const config = {
    database: { path: process.env.DB_PATH || "data/scout-v2.db" },
    normalizer: {
      provider: "ollama" as const,
      base_url: process.env.OLLAMA_URL || "http://battleaxe:11434",
      model: process.env.OLLAMA_MODEL || "qwen3:8b",
    },
    alerts: { min_profit_usd: 25, min_margin_pct: 30 },
  };
  const kl = new KlwinesAdapter();
  const n = await runScan(config, [kl]);
  console.log(`\nSCAN DONE: ${n} opportunities`);
  await kl.close();
}
main().catch(e => { console.error("FAIL:", e); process.exit(1); });
