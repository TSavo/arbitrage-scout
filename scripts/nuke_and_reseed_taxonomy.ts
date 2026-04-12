/**
 * Hard reset: delete ALL taxonomy nodes, fields, enum values, growth audit
 * rows, and re-run the seed from scratch. Leaves products pointing at null
 * taxonomy_node_id (they'll re-classify on next scan).
 */
import { db } from "@/db/client";
import {
  taxonomyNodes,
  taxonomyNodeFields,
  taxonomyNodeFieldEnumValues,
  schemaVersions,
  products,
} from "@/db/schema";
import { seedTaxonomy } from "@/db/seed_taxonomy";
import { sql } from "drizzle-orm";

async function main() {
  console.log("== HARD NUKE ==");
  // Dereference products first so FK doesn't block.
  await db.update(products).set({ taxonomyNodeId: null, extractedSchemaVersion: null });

  // Enum values, fields, audit rows, then nodes (in dependency order).
  await db.delete(taxonomyNodeFieldEnumValues);
  await db.delete(taxonomyNodeFields);
  await db.delete(schemaVersions);
  await db.delete(taxonomyNodes);

  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(taxonomyNodes);
  console.log(`taxonomy_nodes after nuke: ${n}`);

  console.log("\n== RE-SEEDING ==");
  const result = await seedTaxonomy();
  console.log(JSON.stringify(result));
}

main().catch((e) => { console.error(e); process.exit(1); });
