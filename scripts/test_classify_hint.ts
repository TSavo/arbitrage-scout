/**
 * Smoke-test the category-hint fastPath. Synthesize a listing with
 * categoryRaw="Bourbon" and verify classify skips the LLM walk.
 */

import { classify } from "@/pipeline/commands/classify";
import type { RawListing } from "@/pipeline/types";

async function main(): Promise<void> {
  const listing: RawListing = Object.freeze({
    marketplaceId: "test",
    listingId: "hint-1",
    title: "Pappy Van Winkle 15 Year",
    description: "Straight bourbon whiskey",
    categoryRaw: "Bourbon",
    priceUsd: 500,
    shippingUsd: 0,
    scrapedAt: Date.now(),
    extra: {},
  });

  const result = await classify({ listing, extractedFields: {} });
  console.log("usedLlm:", result.usedLlm);
  console.log("path:", result.path.map((n) => n.slug).join(" → "));
  console.log("leaf:", result.path[result.path.length - 1].pathCache);

  // eBay hint
  const ebayListing: RawListing = Object.freeze({
    marketplaceId: "test",
    listingId: "hint-2",
    title: "RTX 4090 Founders Edition",
    description: "",
    priceUsd: 1600,
    shippingUsd: 0,
    scrapedAt: Date.now(),
    extra: { ebay_category_id: "27386" },
  });
  const r2 = await classify({ listing: ebayListing, extractedFields: {} });
  console.log("\nusedLlm:", r2.usedLlm);
  console.log("path:", r2.path.map((n) => n.slug).join(" → "));
  console.log("leaf:", r2.path[r2.path.length - 1].pathCache);
}

main().catch((e) => { console.error(e); process.exit(1); });
