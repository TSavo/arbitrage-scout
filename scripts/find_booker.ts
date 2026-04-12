import { db } from "@/db/client";
import { products, listings, taxonomyNodes } from "@/db/schema";
import { like, or, eq } from "drizzle-orm";

async function main() {
  const hits = await db
    .select()
    .from(products)
    .where(or(like(products.title, "%booker%"), like(products.title, "%Booker%")))
    .limit(20);
  console.log(`Booker's products: ${hits.length}`);
  for (const p of hits) {
    const node = p.taxonomyNodeId ? await db.query.taxonomyNodes.findFirst({ where: eq(taxonomyNodes.id, p.taxonomyNodeId) }) : null;
    const lst = await db.query.listings.findMany({ where: like(listings.title, `%${p.title.slice(0,30)}%`), limit: 3 });
    console.log(`  ${p.id} "${p.title}"`);
    console.log(`    taxonomy: ${node?.slug ?? "(unclassified)"}  | listings=${lst.length}`);
  }
}
main();
