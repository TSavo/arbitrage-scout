import { db } from "@/db/client";
import { opportunities, products, listings } from "@/db/schema";
import { eq, gt, desc } from "drizzle-orm";

async function main() {
  const rows = await db
    .select()
    .from(opportunities)
    .where(gt(opportunities.foundAt, "2026-04-12 16:38"))
    .orderBy(desc(opportunities.profitUsd))
    .limit(25);
  console.log(`Opportunities this scan: ${rows.length}`);
  for (const o of rows) {
    const prod = await db.query.products.findFirst({ where: eq(products.id, o.productId) });
    const lst = await db.query.listings.findFirst({ where: eq(listings.id, o.listingId) });
    console.log(
      `  $${o.profitUsd.toFixed(2)} (${(o.marginPct * 100).toFixed(1)}%) | ` +
      `list $${o.listingPriceUsd.toFixed(2)} → market $${o.marketPriceUsd.toFixed(2)} | ` +
      `${lst?.marketplaceId}: ${(prod?.title ?? "?").slice(0, 70)}`,
    );
  }
}
main();
