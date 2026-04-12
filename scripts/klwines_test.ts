import { KlwinesAdapter } from "@/sources/klwines";
async function main() {
  const a = new KlwinesAdapter();
  console.log("fetching all feeds (auction + new product)...");
  const listings = await a.search("");
  console.log(`TOTAL LISTINGS: ${listings.length}`);
  const byFeed: Record<string, number> = {};
  for (const l of listings) {
    const fk = String(l.extra?.feed_kind ?? "?");
    byFeed[fk] = (byFeed[fk] ?? 0) + 1;
  }
  console.log("by feed_kind:", byFeed);
  console.log("sample auction:", listings.find(l => l.extra?.feed_kind === "auction"));
  console.log("sample new_product:", listings.find(l => l.extra?.feed_kind === "new_product"));
}
main().catch(e => { console.error("FAIL:", e); process.exit(1); });
