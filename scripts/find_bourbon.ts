import { db } from "@/db/client";
import { products, listings, taxonomyNodes } from "@/db/schema";
import { eq, like } from "drizzle-orm";

async function main() {
  const bourbon = await db.query.taxonomyNodes.findFirst({ where: eq(taxonomyNodes.slug, "bourbon") });
  if (!bourbon) { console.log("no bourbon node"); return; }
  const rows = await db
    .select()
    .from(products)
    .where(eq(products.taxonomyNodeId, bourbon.id))
    .limit(15);
  console.log(`Products classified as bourbon: ${rows.length}`);
  for (const p of rows) {
    console.log(`  ${p.title}`);
  }
  console.log("\nAll K&L listings (by marketplace):");
  const kllist = await db.query.listings.findMany({ where: eq(listings.marketplaceId, "klwines"), limit: 5 });
  for (const l of kllist) console.log(`  ${l.title?.slice(0, 80)}`);
}
main();
