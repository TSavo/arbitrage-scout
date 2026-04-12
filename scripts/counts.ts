import { db } from "@/db/client";
import { products, productIdentifiers, listings, pricePoints } from "@/db/schema";
import { sql, eq } from "drizzle-orm";
async function main() {
  const [p] = await db.select({ n: sql<number>`count(*)` }).from(products).where(sql`taxonomy_node_id IS NOT NULL`);
  const [pi] = await db.select({ n: sql<number>`count(*)` }).from(productIdentifiers).where(eq(productIdentifiers.identifierType, "klwines_sku"));
  const [l] = await db.select({ n: sql<number>`count(*)` }).from(listings).where(eq(listings.marketplaceId, "klwines"));
  const [pp] = await db.select({ n: sql<number>`count(*)` }).from(pricePoints).where(eq(pricePoints.source, "klwines"));
  console.log(`products with taxonomy: ${p.n}`);
  console.log(`klwines_sku identifiers: ${pi.n}`);
  console.log(`klwines listings: ${l.n}`);
  console.log(`klwines price_points: ${pp.n}`);
}
main();
