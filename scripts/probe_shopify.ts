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
  // Spirits
  { host: "acespirits.com", category: "spirits" },
  { host: "mashandgrape.com", category: "spirits" },
  { host: "dekanta.com", category: "spirits" },
  { host: "oldtowntequila.com", category: "spirits" },
  { host: "whiskyfoundation.com", category: "spirits" },
  { host: "bountyhunterwine.com", category: "spirits" },
  { host: "whiskybarrel.com", category: "spirits" },
  // Wine
  { host: "lastbottlewines.com", category: "wine" },
  { host: "rarewineco.com", category: "wine" },
  { host: "vinfolio.com", category: "wine" },
  { host: "garagistewine.com", category: "wine" },
  // Trading cards
  { host: "steelcitycollectibles.com", category: "cards" },
  { host: "blowoutcards.com", category: "cards" },
  { host: "dacardworld.com", category: "cards" },
  { host: "trollandtoad.com", category: "cards" },
  { host: "coolstuffinc.com", category: "cards" },
  // Retro games
  { host: "dkoldies.com", category: "retro_games" },
  { host: "lukiegames.com", category: "retro_games" },
  // LEGO / toys
  { host: "firestartoys.com", category: "lego" },
  { host: "minifigs.me", category: "lego" },
  { host: "popinabox.com", category: "funko" },
  // Comics
  { host: "thirdeyecomics.com", category: "comics" },
  { host: "dcbservice.com", category: "comics" },
  { host: "midtowncomics.com", category: "comics" },
  // Watches
  { host: "teddybaldassarre.com", category: "watches" },
  { host: "windupwatchshop.com", category: "watches" },
  // Apple refurb
  { host: "macofalltrades.com", category: "apple" },
  { host: "macsales.com", category: "apple" },
  { host: "gainsaver.com", category: "apple" },
  { host: "plug.tech", category: "apple" },
  // Pens
  { host: "gouletpens.com", category: "pens" },
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
