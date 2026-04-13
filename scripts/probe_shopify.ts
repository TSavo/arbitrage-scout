export {};

/**
 * Probe candidate hosts to see which are Shopify-backed. For each host:
 *   - GET /collections.json → if 200 JSON with .collections, it's Shopify
 *   - GET /products.json?limit=250 → sample to count products and harvest
 *     distinct product_type + vendor + tag values (the categorical signals
 *     we'd use to seed taxonomy subtrees before adding the adapter)
 *
 * No auth. No cache. Just curl-equivalent probes. Prints a compact report.
 */

const HOSTS: { host: string; category: string }[] = [
  // Spirits (batch 2)
  { host: "astorwines.com", category: "spirits" },
  { host: "sipwhiskey.com", category: "spirits" },
  { host: "bourbondive.com", category: "spirits" },
  { host: "wineandwhiskeyglobe.com", category: "spirits" },
  { host: "singlemaltaddicts.com", category: "spirits" },
  { host: "oldbarrelinn.com", category: "spirits" },
  { host: "rarewhiskey101.com", category: "spirits" },
  { host: "scotchandsirens.com", category: "spirits" },
  { host: "millenniumwhiskey.com", category: "spirits" },
  { host: "thewineandwhiskeyshoppe.com", category: "spirits" },
  { host: "thewhiskyshelf.com", category: "spirits" },
  { host: "rarewhisky101.com", category: "spirits" },
  { host: "thepartysource.com", category: "spirits" },
  { host: "houseofmalt.co.uk", category: "spirits" },
  { host: "masterofmalt.com", category: "spirits" },
  // Wine
  { host: "klwinesdtc.com", category: "wine" },
  { host: "vinoshipper.com", category: "wine" },
  { host: "somm.com", category: "wine" },
  { host: "flatirondraft.com", category: "wine" },
  { host: "winecommune.com", category: "wine" },
  { host: "winebid.com", category: "wine" },
  // Watches
  { host: "chronextworld.com", category: "watches" },
  { host: "davidsw.com", category: "watches" },
  { host: "beyondthedial.com", category: "watches" },
  { host: "longislandwatch.com", category: "watches" },
  { host: "watchgecko.com", category: "watches" },
  { host: "hodinkee.com", category: "watches" },
  // Knives (custom + EDC)
  { host: "bladehq.com", category: "knives" },
  { host: "atlanticknife.com", category: "knives" },
  { host: "collectorknives.net", category: "knives" },
  { host: "knifeworks.com", category: "knives" },
  { host: "knifecenter.com", category: "knives" },
  { host: "dlttrading.com", category: "knives" },
  // Audio (vintage + HiFi)
  { host: "audioarkhive.com", category: "audio" },
  { host: "vintagevibesaudio.com", category: "audio" },
  { host: "upscaleaudio.com", category: "audio" },
  { host: "musicdirect.com", category: "audio" },
  { host: "needledoctor.com", category: "audio" },
  // Retro games
  { host: "stoneagegamer.com", category: "retro_games" },
  { host: "pinkgorillagames.com", category: "retro_games" },
  { host: "starlandgames.com", category: "retro_games" },
  { host: "retrogameboyz.com", category: "retro_games" },
  // Trading cards (more)
  { host: "pwccmarketplace.com", category: "cards" },
  { host: "alt.com", category: "cards" },
  { host: "ludkins.com", category: "cards" },
  { host: "tcg-world.com", category: "cards" },
  { host: "pucatrade.com", category: "cards" },
  // Pens / stationery
  { host: "anderson pens.com", category: "pens" },
  { host: "appelboompens.com", category: "pens" },
  { host: "penchalet.com", category: "pens" },
  { host: "jetpens.com", category: "pens" },
  { host: "crazyaboutapens.com", category: "pens" },
  { host: "penaddict.com", category: "pens" },
  // Fragrances
  { host: "maxaroma.com", category: "fragrance" },
  { host: "fragrancenet.com", category: "fragrance" },
  { host: "scentbird.com", category: "fragrance" },
  { host: "luckyscent.com", category: "fragrance" },
  // Sneakers
  { host: "sneakerpolitics.com", category: "sneakers" },
  { host: "kicksonfire.com", category: "sneakers" },
  { host: "shelflife.co.za", category: "sneakers" },
  // Vintage/antique
  { host: "chairishaboutique.com", category: "antiques" },
  { host: "1stdibs.com", category: "antiques" },
  // Photography
  { host: "kehcamera.com", category: "photography" },
  { host: "mpb.com", category: "photography" },
  { host: "adorama.com", category: "photography" },
  // Musical instruments
  { host: "reverb.com", category: "instruments" },
  { host: "westsidemusicllc.com", category: "instruments" },
  { host: "wildwoodguitars.com", category: "instruments" },
  { host: "chicagomusicexchange.com", category: "instruments" },
];

interface Probe {
  readonly host: string;
  readonly category: string;
  readonly shopify: boolean;
  readonly collections?: number;
  readonly sampleProductCount?: number;
  readonly productTypes?: string[];
  readonly vendors?: string[];
  readonly topTags?: string[];
  readonly error?: string;
}

async function getJson(url: string): Promise<unknown | null> {
  try {
    const resp = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 shopify-probe" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) return null;
    const ct = resp.headers.get("content-type") ?? "";
    if (!ct.includes("json")) return null;
    return await resp.json();
  } catch {
    return null;
  }
}

async function probe(host: string, category: string): Promise<Probe> {
  const base = `https://${host}`;
  const collectionsData = await getJson(`${base}/collections.json?limit=250`);
  if (!collectionsData || !(collectionsData as { collections?: unknown }).collections) {
    return { host, category, shopify: false };
  }
  const collections = (collectionsData as { collections: unknown[] }).collections;
  const productsData = await getJson(`${base}/products.json?limit=250`);
  const products = productsData
    ? ((productsData as { products?: Array<{ product_type?: string; vendor?: string; tags?: string }> }).products ?? [])
    : [];

  const types = new Map<string, number>();
  const vendors = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const p of products) {
    if (p.product_type) types.set(p.product_type, (types.get(p.product_type) ?? 0) + 1);
    if (p.vendor) vendors.set(p.vendor, (vendors.get(p.vendor) ?? 0) + 1);
    const rawTags = (p as { tags?: unknown }).tags;
    const tagList: string[] = Array.isArray(rawTags)
      ? (rawTags as string[]).filter((x) => typeof x === "string")
      : typeof rawTags === "string"
        ? rawTags.split(",").map((t) => t.trim()).filter(Boolean)
        : [];
    for (const t of tagList) tags.set(t, (tags.get(t) ?? 0) + 1);
  }

  const sortTop = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k}(${v})`);

  return {
    host,
    category,
    shopify: true,
    collections: collections.length,
    sampleProductCount: products.length,
    productTypes: sortTop(types, 10),
    vendors: sortTop(vendors, 5),
    topTags: sortTop(tags, 10),
  };
}

async function main(): Promise<void> {
  const results: Probe[] = [];
  // Probe 4 at a time to be polite
  const batchSize = 4;
  for (let i = 0; i < HOSTS.length; i += batchSize) {
    const batch = HOSTS.slice(i, i + batchSize);
    const out = await Promise.all(batch.map((h) => probe(h.host, h.category)));
    results.push(...out);
    process.stdout.write(".");
  }
  console.log("\n");

  console.log("═══ SHOPIFY-BACKED ═══\n");
  for (const r of results.filter((r) => r.shopify)) {
    console.log(`[${r.category}] ${r.host}`);
    console.log(`  collections=${r.collections}  products_sample=${r.sampleProductCount}`);
    if (r.productTypes?.length) console.log(`  product_types: ${r.productTypes.join(", ")}`);
    if (r.vendors?.length) console.log(`  vendors: ${r.vendors.join(", ")}`);
    if (r.topTags?.length) console.log(`  tags: ${r.topTags.slice(0, 8).join(", ")}`);
    console.log("");
  }

  console.log("═══ NOT SHOPIFY (custom / blocked) ═══\n");
  for (const r of results.filter((r) => !r.shopify)) {
    console.log(`[${r.category}] ${r.host}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
