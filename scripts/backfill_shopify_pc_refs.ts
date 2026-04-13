/**
 * Step 4 — Shopify product_type + PriceCharting category refs.
 *
 * Shopify refs: from the probe run we know product_types per host. Map
 * each to our taxonomy. Source="shopify_product_type", external_id is the
 * normalized product_type string (lowercase-slugified). Since two stores
 * using "Bourbon" mean the same thing, we don't qualify by host — the
 * external_id is the product_type itself. One row per (node, product_type)
 * pair keyed by node_id + (source, external_id).
 *
 * PriceCharting refs: hardcoded in stock.ts as CSV_TAXONOMY_PATH. Pull
 * them into the refs table so future imports can resolve without code
 * changes.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { taxonomyNodes, taxonomyExternalRefs } from "@/db/schema";

function slugify(s: string): string {
  return s.toLowerCase().replace(/[&,'’"]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// Shopify product_type → our node path. Derived from the probe report.
// One product_type maps to ONE node; multiple stores can emit same type.
const SHOPIFY_MAP: Record<string, string> = {
  // Liquor
  "Bourbon": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/whiskey/bourbon",
  "Straight Bourbon Whiskey": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/whiskey/bourbon",
  "Rye": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/whiskey/rye",
  "Rye Whiskey": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/whiskey/rye",
  "Tennessee Whiskey": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/whiskey/tennessee_whiskey",
  "Single Malt Scotch": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/whiskey/scotch/single_malt_scotch",
  "Scotch": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/whiskey/scotch",
  "Blended Scotch": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/whiskey/scotch",
  "Irish Whiskey": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/whiskey",
  "Whisky": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/whiskey",
  "Whiskey": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/whiskey",
  "World Whisky": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/whiskey",
  "Gin": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/gin",
  "Vodka": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/vodka",
  "Rum": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/rum",
  "Tequila": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/tequila",
  "Mezcal": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/mezcal",
  "Cordials / Liqueurs": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/cordials_liqueurs",
  "Liqueur": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/cordials_liqueurs",
  "Vermouth": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/vermouth",
  "Absinthe": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/absinthe",
  "Brandy": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/brandy",
  "Cognac": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/brandy",
  "Shochu": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/shochu",
  "Umeshu": "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/umeshu",
  "Sake": "/food_beverages_tobacco/beverages/alcoholic_beverages/wine/sake",

  // Wine
  "Wine": "/food_beverages_tobacco/beverages/alcoholic_beverages/wine",
  "Red Wine": "/food_beverages_tobacco/beverages/alcoholic_beverages/wine/red_wine",
  "White Wine": "/food_beverages_tobacco/beverages/alcoholic_beverages/wine/white_wine",
  "Rosé Wine": "/food_beverages_tobacco/beverages/alcoholic_beverages/wine/rose_wine",
  "Sparkling": "/food_beverages_tobacco/beverages/alcoholic_beverages/wine/sparkling_wine",
  "Sparkling Wine": "/food_beverages_tobacco/beverages/alcoholic_beverages/wine/sparkling_wine",

  // Cards
  "Pokemon Single": "/collectibles/trading_cards/pokemon",
  "Pokemon Sealed": "/collectibles/trading_cards/pokemon",

  // Watches
  "Watches": "/apparel_accessories/jewelry/watches",
  "Watch": "/apparel_accessories/jewelry/watches",

  // Pens
  "Fountain Pens": "/office_products/writing_instruments/fountain_pens",
  "Rollerball Pens": "/office_products/writing_instruments/rollerball_pens",
  "Bottled Ink": "/office_products/writing_supplies/bottled_ink",
  "Ink Samples": "/office_products/writing_supplies/ink_samples",
  "Nibs": "/office_products/writing_instruments/fountain_pens",

  // Apple (plug.tech)
  "Phone": "/electronics/mobile_phones",
  "Tablet": "/electronics/tablets",
  "Computer": "/electronics/computers/laptops",
  "Wearable": "/electronics/wearables",
  "Hearable": "/electronics/audio/headphones",
};

// PriceCharting CSV category → our node path. Kept in sync with
// src/scanner/stock.ts CSV_TAXONOMY_PATH.
const PC_MAP: Record<string, string> = {
  videogames: "/electronics/video_games/physical_game_media",
  pokemon: "/collectibles/trading_cards/pokemon",
  magic: "/collectibles/trading_cards/mtg",
  yugioh: "/collectibles/trading_cards/yugioh",
  onepiece: "/collectibles/trading_cards/one_piece",
  funko: "/collectibles/figures/funko_pop",
  lego: "/toys_games/building_sets/lego",
  comics: "/collectibles/comic_books",
  coins: "/collectibles/coins",
};

async function resolveNodeId(path: string): Promise<number | null> {
  const row = await db.query.taxonomyNodes.findFirst({
    where: eq(taxonomyNodes.pathCache, path),
    columns: { id: true },
  });
  return row?.id ?? null;
}

async function upsertRef(
  nodeId: number, source: string, externalId: string, externalPath: string, confidence: number,
): Promise<"inserted" | "skipped"> {
  const existing = await db.select({ id: taxonomyExternalRefs.id })
    .from(taxonomyExternalRefs)
    .where(and(
      eq(taxonomyExternalRefs.nodeId, nodeId),
      eq(taxonomyExternalRefs.source, source),
    ))
    .limit(1);
  if (existing.length > 0) return "skipped";
  await db.insert(taxonomyExternalRefs).values({
    nodeId, source, externalId, externalPath, confidence,
    createdAt: new Date().toISOString(),
  });
  return "inserted";
}

async function main(): Promise<void> {
  console.log("─ Shopify product_type refs ─");
  let shopifyIns = 0, shopifyMiss = 0;
  for (const [ptype, path] of Object.entries(SHOPIFY_MAP)) {
    const nodeId = await resolveNodeId(path);
    if (!nodeId) {
      console.log(`  MISS path not in DB: ${path} (product_type="${ptype}")`);
      shopifyMiss++;
      continue;
    }
    const r = await upsertRef(nodeId, "shopify_product_type", slugify(ptype), ptype, 1.0);
    if (r === "inserted") shopifyIns++;
  }
  console.log(`  inserted ${shopifyIns}, missing paths ${shopifyMiss}`);

  console.log("\n─ PriceCharting category refs ─");
  let pcIns = 0, pcMiss = 0;
  for (const [cat, path] of Object.entries(PC_MAP)) {
    const nodeId = await resolveNodeId(path);
    if (!nodeId) {
      console.log(`  MISS path not in DB: ${path} (category="${cat}")`);
      pcMiss++;
      continue;
    }
    const r = await upsertRef(nodeId, "pricecharting", cat, cat, 1.0);
    if (r === "inserted") pcIns++;
  }
  console.log(`  inserted ${pcIns}, missing paths ${pcMiss}`);

  // Summary
  console.log("\n─ coverage summary ─");
  const total = await db.select({ c: taxonomyNodes.id }).from(taxonomyNodes);
  for (const source of ["google_gpt", "ebay_us", "shopify_product_type", "pricecharting"]) {
    const rows = await db.select().from(taxonomyExternalRefs).where(eq(taxonomyExternalRefs.source, source));
    console.log(`  ${source.padEnd(24)} ${rows.length} refs (of ${total.length} nodes)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
