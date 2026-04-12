import { classify } from "@/pipeline/commands/classify";
import { buildLlm } from "@/scanner/helpers";

async function main() {
  const llm = buildLlm({ provider: "ollama", base_url: "http://battleaxe:11434", model: "qwen3:8b" });
  const listing = {
    marketplaceId: "klwines",
    listingId: "test-" + Math.random(),
    title: "2023 Istine Chianti Classico",
    priceUsd: 32.99,
    shippingUsd: 0,
    url: "",
    scrapedAt: Date.now(),
    extra: {},
  };
  const result = await classify({ listing, extractedFields: {}, llmClient: llm ?? undefined });
  console.log("path:", result.path.map(n => n.slug).join(" → "));
  console.log("events:", result.growthEvents.length);
}
main().catch(e => { console.error(e); process.exit(1); });
