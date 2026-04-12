/**
 * Remove tentative taxonomy nodes (canonical=false) created during a bad scan.
 * Seed-derived nodes are canonical=true, so they're preserved. Listings/products
 * that pointed at deleted nodes get re-parented to root (they'll re-classify on
 * the next scan via tier-3 since klwines_sku identifiers were already cleared).
 */
import { db } from "@/db/client";
import {
  taxonomyNodes,
  taxonomyNodeFields,
  taxonomyNodeFieldEnumValues,
  schemaVersions,
  products,
} from "@/db/schema";
import { sql, eq, inArray, and } from "drizzle-orm";

async function main() {
  const tentative = await db
    .select({ id: taxonomyNodes.id, slug: taxonomyNodes.slug, parentId: taxonomyNodes.parentId })
    .from(taxonomyNodes)
    .where(eq(taxonomyNodes.canonical, false));

  console.log(`Found ${tentative.length} tentative nodes:`);
  for (const n of tentative) {
    console.log(`  id=${n.id} slug=${n.slug} parent=${n.parentId}`);
  }
  if (tentative.length === 0) {
    console.log("Nothing to clean up.");
    return;
  }

  const ids = tentative.map((n) => n.id);

  // Products pointing at these → set taxonomy_node_id = null (re-classify later)
  const repointed = await db
    .update(products)
    .set({ taxonomyNodeId: null, extractedSchemaVersion: null })
    .where(inArray(products.taxonomyNodeId, ids));
  console.log(`  products re-pointed to null: ${JSON.stringify(repointed)}`);

  // Child fields + enum values
  const fieldRows = await db
    .select({ id: taxonomyNodeFields.id })
    .from(taxonomyNodeFields)
    .where(inArray(taxonomyNodeFields.nodeId, ids));
  if (fieldRows.length) {
    const fieldIds = fieldRows.map((f) => f.id);
    await db.delete(taxonomyNodeFieldEnumValues).where(inArray(taxonomyNodeFieldEnumValues.fieldId, fieldIds));
    await db.delete(taxonomyNodeFields).where(inArray(taxonomyNodeFields.id, fieldIds));
    console.log(`  deleted ${fieldIds.length} fields + their enum values`);
  }

  // Schema version audit rows referencing these nodes
  await db.delete(schemaVersions).where(inArray(schemaVersions.nodeId, ids));

  // Finally the nodes themselves (delete children before parents — we're in
  // a flat "tentative only" set, but do them in order of descending depth to
  // be safe against FK: sort by parent chain)
  const byId = new Map(tentative.map((n) => [n.id, n]));
  function depth(id: number): number {
    let d = 0, cur = byId.get(id);
    while (cur?.parentId && byId.has(cur.parentId)) {
      d++;
      cur = byId.get(cur.parentId);
    }
    return d;
  }
  tentative.sort((a, b) => depth(b.id) - depth(a.id));

  for (const n of tentative) {
    await db.delete(taxonomyNodes).where(eq(taxonomyNodes.id, n.id));
  }
  console.log(`  deleted ${tentative.length} tentative nodes`);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(taxonomyNodes);
  console.log(`\nTaxonomy now has ${total} nodes (canonical only).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
