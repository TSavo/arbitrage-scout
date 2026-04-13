/**
 * Backfill eBay US category tree refs into taxonomy_external_refs.
 *
 * Uses EBAY_APP_ID + EBAY_CERT_ID (client credentials grant) to mint an
 * application OAuth token, pulls the full EBAY_US category tree, flattens
 * it, and for each DB node tries:
 *   1. Exact slug match (our slug == slugify(eBay label path))
 *   2. Alias overrides (explicit remaps)
 *   3. Ancestor rollup (first GPT-style match walking up our path)
 *
 * Writes source='ebay_us', external_id=<numeric categoryId>,
 *        external_path=<full label path>, confidence ∈ {1.0, 0.95, 0.85}
 *
 * Idempotent: skips nodes that already have an ebay_us ref.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { taxonomyNodes, taxonomyExternalRefs } from "@/db/schema";

const APP_ID = process.env.EBAY_APP_ID;
const CERT_ID = process.env.EBAY_CERT_ID;
if (!APP_ID || !CERT_ID) {
  throw new Error("EBAY_APP_ID and EBAY_CERT_ID required");
}

// Root aliases — map OUR top-level to eBay top-level category ID directly.
// Derived from `peek_ebay_toplevel.ts` output (34 top-level eBay categories).
const ROOT_ALIASES: Record<string, { id: string; labelPath: string }> = {
  "/apparel_accessories": { id: "11450", labelPath: "Clothing, Shoes & Accessories" },
  "/arts_entertainment": { id: "45100", labelPath: "Entertainment Memorabilia" },
  "/baby_toddler": { id: "2984", labelPath: "Baby" },
  "/business_industrial": { id: "12576", labelPath: "Business & Industrial" },
  "/cameras_optics": { id: "625", labelPath: "Cameras & Photo" },
  "/collectibles": { id: "1", labelPath: "Collectibles" },
  "/electronics": { id: "293", labelPath: "Consumer Electronics" },
  "/food_beverages_tobacco": { id: "14308", labelPath: "Home & Garden > Food & Beverages" },
  "/gift_cards": { id: "172008", labelPath: "Gift Cards & Coupons" },
  "/hardware": { id: "159912", labelPath: "Business & Industrial > MRO & Industrial Supply" },
  "/health_beauty": { id: "26395", labelPath: "Health & Beauty" },
  "/home_garden": { id: "11700", labelPath: "Home & Garden" },
  "/luggage_bags": { id: "169291", labelPath: "Clothing, Shoes & Accessories" },
  "/media": { id: "267", labelPath: "Books & Magazines" },
  "/office_products": { id: "88739", labelPath: "Business & Industrial > Office" },
  "/software": { id: "58058", labelPath: "Computers/Tablets & Networking > Software" },
  "/sporting_goods": { id: "888", labelPath: "Sporting Goods" },
  "/toys_games": { id: "220", labelPath: "Toys & Hobbies" },
  "/vehicles_parts": { id: "6000", labelPath: "eBay Motors" },
};

// Deeper aliases — OUR path → { eBay category id, full eBay label path }.
// Derived from eBay US taxonomy discovery (scripts/ebay_search_paths.ts).
// Direct id map avoids slugification mismatches.
const DIRECT_ALIASES: Record<string, { id: string; labelPath: string }> = {
  // Alcohol — eBay has NO whiskey leaf. All whiskey/bourbon/scotch/rye/
  // japanese_whisky go to "Other Wines, Liqueurs & Spirits" as the best
  // available rollup. Losing this granularity is an eBay limitation.
  "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits": {
    id: "258854", labelPath: "Home & Garden > Food & Beverages > Alcohol & Alcohol Mixers > Other Wines, Liqueurs & Spirits" },
  "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/whiskey": {
    id: "258854", labelPath: "Home & Garden > Food & Beverages > Alcohol & Alcohol Mixers > Other Wines, Liqueurs & Spirits" },
  "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/tequila": {
    id: "258509", labelPath: "Home & Garden > Food & Beverages > Alcohol & Alcohol Mixers > Tequila & Agave Drinks" },
  "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/mezcal": {
    id: "258509", labelPath: "Home & Garden > Food & Beverages > Alcohol & Alcohol Mixers > Tequila & Agave Drinks" },
  "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/vodka": {
    id: "258850", labelPath: "Home & Garden > Food & Beverages > Alcohol & Alcohol Mixers > Vodka & Akvavit" },
  "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/absinthe": {
    id: "258505", labelPath: "Home & Garden > Food & Beverages > Alcohol & Alcohol Mixers > Absinthe" },
  "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/shochu": {
    id: "258506", labelPath: "Home & Garden > Food & Beverages > Alcohol & Alcohol Mixers > Sake, Soju & Rice Based" },
  "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/cordials_liqueurs": {
    id: "258857", labelPath: "Home & Garden > Food & Beverages > Alcohol & Alcohol Mixers > Liqueurs" },
  "/food_beverages_tobacco/beverages/alcoholic_beverages/liquor_spirits/japanese_whisky": {
    id: "258854", labelPath: "Home & Garden > Food & Beverages > Alcohol & Alcohol Mixers > Other Wines, Liqueurs & Spirits" },
  "/food_beverages_tobacco/beverages/alcoholic_beverages/wine": {
    id: "258853", labelPath: "Home & Garden > Food & Beverages > Alcohol & Alcohol Mixers > Wines" },
  "/food_beverages_tobacco/beverages/alcoholic_beverages/wine/sparkling_wine": {
    id: "258853", labelPath: "Home & Garden > Food & Beverages > Alcohol & Alcohol Mixers > Wines" },
  "/food_beverages_tobacco/beverages/alcoholic_beverages/wine/sake": {
    id: "258506", labelPath: "Home & Garden > Food & Beverages > Alcohol & Alcohol Mixers > Sake, Soju & Rice Based" },

  // Cards
  "/collectibles/trading_cards": { id: "183454", labelPath: "Toys & Hobbies > Collectible Card Games" },
  "/collectibles/trading_cards/pokemon": { id: "183454", labelPath: "Toys & Hobbies > Collectible Card Games" },
  "/collectibles/trading_cards/mtg": { id: "183454", labelPath: "Toys & Hobbies > Collectible Card Games" },
  "/collectibles/trading_cards/yugioh": { id: "183454", labelPath: "Toys & Hobbies > Collectible Card Games" },
  "/collectibles/trading_cards/one_piece": { id: "183454", labelPath: "Toys & Hobbies > Collectible Card Games" },
  "/collectibles/trading_cards/sports_cards": { id: "64482", labelPath: "Sports Mem, Cards & Fan Shop > Sports Trading Cards" },

  // Figures / Funko
  "/collectibles/figures": { id: "246", labelPath: "Toys & Hobbies > Action Figures & Accessories > Action Figures" },
  "/collectibles/figures/funko_pop": { id: "149372", labelPath: "Collectibles > Pinbacks, Bobbles, Lunchboxes > Bobbleheads, Nodders > Modern (1991-Now)" },

  // Comics
  "/collectibles/comic_books": { id: "259104", labelPath: "Collectibles > Comic Books & Memorabilia > Comics > Comics & Graphic Novels" },

  // Computers
  "/electronics/computers/laptops": { id: "175672", labelPath: "Computers/Tablets & Networking > Laptops & Netbooks" },
  "/electronics/computers/laptops/apple_macbook": { id: "111422", labelPath: "Computers/Tablets & Networking > Laptops & Netbooks > Apple Laptops" },
  "/electronics/computers/laptops/apple_macbook/macbook_pro": { id: "111422", labelPath: "Computers/Tablets & Networking > Laptops & Netbooks > Apple Laptops" },
  "/electronics/computers/laptops/apple_macbook/macbook_air": { id: "111422", labelPath: "Computers/Tablets & Networking > Laptops & Netbooks > Apple Laptops" },
  "/electronics/computers/desktops": { id: "179", labelPath: "Computers/Tablets & Networking > Desktops & All-In-Ones > PC Desktops & All-In-Ones" },
  "/electronics/computers/desktops/apple_mac": { id: "111418", labelPath: "Computers/Tablets & Networking > Desktops & All-In-Ones > Apple Desktops & All-In-Ones" },
  "/electronics/computers/desktops/apple_mac/imac": { id: "111418", labelPath: "Computers/Tablets & Networking > Desktops & All-In-Ones > Apple Desktops & All-In-Ones" },
  "/electronics/computers/desktops/apple_mac/mac_mini": { id: "111418", labelPath: "Computers/Tablets & Networking > Desktops & All-In-Ones > Apple Desktops & All-In-Ones" },
  "/electronics/computers/desktops/apple_mac/mac_studio": { id: "111418", labelPath: "Computers/Tablets & Networking > Desktops & All-In-Ones > Apple Desktops & All-In-Ones" },
  "/electronics/tablets": { id: "171485", labelPath: "Computers/Tablets & Networking > Tablets & eBook Readers" },
  "/electronics/tablets/apple_ipad": { id: "171485", labelPath: "Computers/Tablets & Networking > Tablets & eBook Readers" },

  // Components
  "/electronics/computers/components/graphics_cards": { id: "27386", labelPath: "Computers/Tablets & Networking > Computer Components & Parts > Graphics/Video Cards" },
  "/electronics/computers/components/memory_ram": { id: "170083", labelPath: "Computers/Tablets & Networking > Computer Components & Parts > Memory (RAM)" },
  "/electronics/computers/components/storage_drives": { id: "175669", labelPath: "Computers/Tablets & Networking > Drives, Storage & Blank Media > Hard Drives (HDD, SSD & NAS) > Solid State Drives" },

  // Phones / wearables
  "/electronics/mobile_phones/apple_iphone": { id: "9355", labelPath: "Cell Phones & Accessories > Cell Phones & Smartphones" },
  "/electronics/wearables": { id: "178893", labelPath: "Cell Phones & Accessories > Smart Watches" },
  "/electronics/wearables/apple_watch": { id: "178893", labelPath: "Cell Phones & Accessories > Smart Watches" },

  // Video games
  "/electronics/video_games": { id: "1249", labelPath: "Video Games & Consoles" },
  "/electronics/video_games/physical_game_media": { id: "139973", labelPath: "Video Games & Consoles > Video Games" },

  // Watches (general)
  "/apparel_accessories/jewelry": { id: "281", labelPath: "Jewelry & Watches" },
  "/apparel_accessories/jewelry/watches": { id: "31387", labelPath: "Jewelry & Watches > Watches, Parts & Accessories > Watches > Wristwatches" },
  "/apparel_accessories/jewelry/watches/mechanical": { id: "31387", labelPath: "Jewelry & Watches > Watches, Parts & Accessories > Watches > Wristwatches" },
  "/apparel_accessories/jewelry/watches/automatic": { id: "31387", labelPath: "Jewelry & Watches > Watches, Parts & Accessories > Watches > Wristwatches" },
  "/apparel_accessories/jewelry/watches/quartz": { id: "31387", labelPath: "Jewelry & Watches > Watches, Parts & Accessories > Watches > Wristwatches" },

  // Pens (eBay files these under Collectibles, not Office!)
  "/office_products/writing_instruments/fountain_pens": { id: "7280", labelPath: "Collectibles > Pens & Writing Instruments > Pens > Fountain Pens" },
  "/office_products/writing_instruments/rollerball_pens": { id: "41686", labelPath: "Collectibles > Pens & Writing Instruments > Pens > Rollerball Pens" },
  "/office_products/writing_instruments/ballpoint_pens": { id: "41687", labelPath: "Collectibles > Pens & Writing Instruments > Pens > Ballpoint Pens" },

  // LEGO
  "/toys_games/building_sets/lego": { id: "19006", labelPath: "Toys & Hobbies > Building Toys > LEGO (R) Building Toys > LEGO (R) Complete Sets & Packs" },
};

const ALIASES: Record<string, string> = {};

function slugifySegment(seg: string): string {
  return seg.toLowerCase().replace(/[&,'’"]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

interface EbayCategory {
  readonly category: { readonly categoryId: string; readonly categoryName: string };
  readonly childCategoryTreeNodes?: EbayCategory[];
}
interface FlatCat { readonly id: string; readonly labelPath: string; readonly slugPath: string; }

async function mintToken(): Promise<string> {
  const basic = Buffer.from(`${APP_ID}:${CERT_ID}`).toString("base64");
  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${basic}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
  });
  const body = await resp.text();
  if (!resp.ok) throw new Error(`eBay token ${resp.status}: ${body.slice(0, 200)}`);
  const json = JSON.parse(body) as { access_token?: string };
  if (!json.access_token) throw new Error(`no access_token: ${body.slice(0, 200)}`);
  return json.access_token;
}

async function fetchTreeId(token: string): Promise<string> {
  const resp = await fetch(
    "https://api.ebay.com/commerce/taxonomy/v1/get_default_category_tree_id?marketplace_id=EBAY_US",
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) throw new Error(`tree_id ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const json = await resp.json() as { categoryTreeId?: string };
  if (!json.categoryTreeId) throw new Error("no categoryTreeId");
  return json.categoryTreeId;
}

async function fetchTree(token: string, treeId: string): Promise<EbayCategory> {
  const resp = await fetch(
    `https://api.ebay.com/commerce/taxonomy/v1/category_tree/${treeId}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!resp.ok) throw new Error(`tree ${resp.status}`);
  const json = await resp.json() as { rootCategoryNode: EbayCategory };
  return json.rootCategoryNode;
}

function flatten(node: EbayCategory, labelPath: string[], out: FlatCat[]): void {
  const path = [...labelPath, node.category.categoryName];
  const slugPath = "/" + path.slice(1).map(slugifySegment).join("/"); // skip "Root"
  if (path.length > 1) {
    out.push({ id: node.category.categoryId, labelPath: path.slice(1).join(" > "), slugPath });
  }
  for (const child of node.childCategoryTreeNodes ?? []) flatten(child, path, out);
}

function* ancestors(path: string): Generator<string> {
  const parts = path.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) yield "/" + parts.slice(0, i).join("/");
}

async function main(): Promise<void> {
  console.log("minting eBay app token…");
  const token = await mintToken();
  console.log("fetching EBAY_US tree id…");
  const treeId = await fetchTreeId(token);
  console.log(`tree id: ${treeId}, fetching full tree…`);
  const root = await fetchTree(token, treeId);
  const flat: FlatCat[] = [];
  flatten(root, [], flat);
  console.log(`flattened ${flat.length} eBay categories`);

  const byPath = new Map(flat.map((c) => [c.slugPath, c]));
  // Last-segment index — e.g. "whiskey" → [all FlatCat whose slug ends in "whiskey"]
  const byLastSegment = new Map<string, FlatCat[]>();
  for (const c of flat) {
    const last = c.slugPath.split("/").pop()!;
    if (!byLastSegment.has(last)) byLastSegment.set(last, []);
    byLastSegment.get(last)!.push(c);
  }
  const nodes = await db.select({ id: taxonomyNodes.id, path: taxonomyNodes.pathCache }).from(taxonomyNodes);
  const now = new Date().toISOString();

  let exact = 0, alias = 0, ancestor = 0, lastSeg = 0, rootHits = 0, unmatched = 0, already = 0;
  const unmatchedSample: string[] = [];

  for (const node of nodes) {
    const existing = await db.select({ id: taxonomyExternalRefs.id }).from(taxonomyExternalRefs)
      .where(and(eq(taxonomyExternalRefs.nodeId, node.id), eq(taxonomyExternalRefs.source, "ebay_us")))
      .limit(1);
    if (existing.length > 0) { already++; continue; }

    // 0. Direct ID alias (strongest — bypasses slugification).
    let hit: FlatCat | undefined;
    let conf = 1.0;
    const direct = DIRECT_ALIASES[node.path];
    if (direct) {
      hit = { id: direct.id, labelPath: direct.labelPath, slugPath: node.path };
      conf = 0.95;
    }

    // 1. Exact slug match
    if (!hit) { hit = byPath.get(node.path); if (hit) conf = 1.0; }

    // 2. Alias (slug-based) — legacy, unused now but kept for flex
    if (!hit) {
      const aliasPath = ALIASES[node.path];
      if (aliasPath) {
        hit = byPath.get(aliasPath);
        if (hit) conf = 0.95;
      }
    }

    // 3. Last-segment match — find any eBay category whose path ends in
    //    our last slug. Pick the deepest match (likely the most specific).
    //    Good for whiskey → Wine/Spirits/Whiskey, funko_pop → Collectibles/
    //    Toys > Action Figures > Pop! Vinyl, etc.
    let matchKind: "exact" | "alias" | "lastSeg" | "ancestor" | "root" | null = null;
    if (hit) matchKind = conf === 1.0 ? "exact" : "alias";
    if (!hit) {
      const lastSlug = node.path.split("/").pop() ?? "";
      const candidates = byLastSegment.get(lastSlug) ?? [];
      if (candidates.length > 0) {
        // Prefer deepest match (most specific leaf).
        candidates.sort((a, b) => b.slugPath.split("/").length - a.slugPath.split("/").length);
        hit = candidates[0];
        conf = 0.7;
        matchKind = "lastSeg";
      }
    }

    // 4. Ancestor fallback (our path) — also consults DIRECT_ALIASES so
    //    children of aliased nodes inherit their parent's eBay mapping.
    if (!hit) {
      for (const anc of ancestors(node.path)) {
        const ancDirect = DIRECT_ALIASES[anc];
        if (ancDirect) {
          hit = { id: ancDirect.id, labelPath: ancDirect.labelPath, slugPath: anc };
          conf = 0.8; matchKind = "ancestor"; break;
        }
        hit = byPath.get(anc);
        if (hit) { conf = 0.8; matchKind = "ancestor"; break; }
        const aAlias = ALIASES[anc];
        if (aAlias) { hit = byPath.get(aAlias); if (hit) { conf = 0.8; matchKind = "ancestor"; break; } }
      }
    }

    // 5. Root alias — our top-level to eBay top-level, last resort rollup.
    if (!hit) {
      const rootKey = "/" + node.path.split("/").filter(Boolean)[0];
      const rAlias = ROOT_ALIASES[rootKey];
      if (rAlias) {
        hit = { id: rAlias.id, labelPath: rAlias.labelPath, slugPath: rootKey };
        conf = 0.6;
        matchKind = "root";
      }
    }

    if (!hit) {
      unmatched++;
      if (unmatchedSample.length < 15) unmatchedSample.push(node.path);
      continue;
    }

    await db.insert(taxonomyExternalRefs).values({
      nodeId: node.id, source: "ebay_us",
      externalId: hit.id, externalPath: hit.labelPath,
      confidence: conf, createdAt: now,
    });
    if (matchKind === "exact") exact++;
    else if (matchKind === "alias") alias++;
    else if (matchKind === "lastSeg") lastSeg++;
    else if (matchKind === "ancestor") ancestor++;
    else if (matchKind === "root") rootHits++;
  }

  console.log(`\nresults over ${nodes.length} nodes:`);
  console.log(`  already had ref:   ${already}`);
  console.log(`  exact slug match:   ${exact}   (conf 1.00)`);
  console.log(`  alias rule:         ${alias}   (conf 0.95)`);
  console.log(`  last-segment match: ${lastSeg}   (conf 0.70)`);
  console.log(`  ancestor fallback:  ${ancestor}   (conf 0.80)`);
  console.log(`  root alias rollup:  ${rootHits}   (conf 0.60)`);
  console.log(`  unmatched:          ${unmatched}`);
  if (unmatchedSample.length) {
    console.log(`\nunmatched sample:`);
    for (const p of unmatchedSample) console.log(`  ${p}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
