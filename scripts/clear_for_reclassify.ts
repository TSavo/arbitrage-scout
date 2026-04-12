/**
 * Pre-rerun cleanup: clear the tier-1 short-circuit (klwines_sku identifiers)
 * and the HTTP cache so a fresh scan re-classifies every listing under the
 * current prompts + taxonomy.
 *
 * Products, listings, price_points are preserved. ResolveIdentity will re-link
 * each listing to the existing product via embedding/FTS similarity and update
 * its taxonomyNodeId to reflect the new classify result.
 */

import { db } from "@/db/client";
import { productIdentifiers, httpCache } from "@/db/schema";
import { sql, eq } from "drizzle-orm";

async function main() {
  const [idsBefore] = await db
    .select({ n: sql<number>`count(*)` })
    .from(productIdentifiers)
    .where(eq(productIdentifiers.identifierType, "klwines_sku"));
  await db.delete(productIdentifiers).where(eq(productIdentifiers.identifierType, "klwines_sku"));
  const [idsAfter] = await db
    .select({ n: sql<number>`count(*)` })
    .from(productIdentifiers)
    .where(eq(productIdentifiers.identifierType, "klwines_sku"));
  console.log(`product_identifiers (klwines_sku): ${idsBefore.n} → ${idsAfter.n}`);

  const [cacheBefore] = await db.select({ n: sql<number>`count(*)` }).from(httpCache);
  await db.delete(httpCache);
  const [cacheAfter] = await db.select({ n: sql<number>`count(*)` }).from(httpCache);
  console.log(`http_cache: ${cacheBefore.n} → ${cacheAfter.n}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
