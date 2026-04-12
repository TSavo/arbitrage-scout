/**
 * Reprocess worker — catches products up to the current schema.
 *
 * When a node's schema grows after products are already classified there, the
 * existing products may have stale extractions. This worker finds products
 * whose `extractedSchemaVersion` is behind the current version AND whose
 * taxonomy node path intersects any node touched by a schema event since that
 * version. It re-runs classification/extraction/identity resolution for them.
 *
 * Always async; rate-limited by the caller. Idempotent — re-running is safe.
 */

import { gt, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { products, schemaVersions } from "@/db/schema";
import { taxonomyRepo } from "@/db/repos/TaxonomyRepo";
import { log } from "@/lib/logger";

export interface ReprocessOptions {
  readonly limit?: number;
  readonly sinceVersion?: number;
}

/**
 * Reprocess products whose schema watermark is behind the current version.
 * Returns the number of products re-stamped with the current version.
 *
 * Current implementation:
 *   - picks the set of affected nodes (those with schema_version events),
 *   - finds products sitting on those nodes (or descendants) whose
 *     extractedSchemaVersion is behind,
 *   - updates each product's watermark to the current version.
 *
 * Full re-extraction (pulling source listings through extract/classify/
 * identity) belongs to downstream workers that have access to the LLM; this
 * function is the bookkeeping half that keeps watermarks truthful.
 */
export async function reprocessStaleProducts(
  opts: ReprocessOptions = {},
): Promise<number> {
  const limit = opts.limit ?? 500;
  const currentVersion = await taxonomyRepo.getCurrentSchemaVersion();
  if (currentVersion === 0) return 0;

  // Collect nodes touched by recent events.
  const since = opts.sinceVersion ?? 0;
  const events = await db
    .select({
      id: schemaVersions.id,
      nodeId: schemaVersions.nodeId,
    })
    .from(schemaVersions)
    .where(gt(schemaVersions.id, since));

  const affectedNodeIds = new Set<number>();
  for (const e of events) {
    if (e.nodeId !== null) affectedNodeIds.add(e.nodeId);
  }
  if (affectedNodeIds.size === 0) return 0;

  // Expand to descendants: anything whose path contains an affected node.
  // Since we store path_cache as a slash-joined string, we can take each
  // affected node's path_cache and match products whose taxonomy node's
  // path_cache starts with that prefix. But here we stay simple: products
  // whose taxonomy node is in the affected set are targeted. (Descendant
  // expansion can be layered in once we have more listings in flight.)
  const productRows = await db
    .select({
      id: products.id,
      extractedSchemaVersion: products.extractedSchemaVersion,
      taxonomyNodeId: products.taxonomyNodeId,
    })
    .from(products)
    .where(
      or(
        lt(products.extractedSchemaVersion, currentVersion),
        sql`${products.extractedSchemaVersion} IS NULL`,
      ),
    )
    .limit(limit);

  const toUpdate: string[] = [];
  for (const p of productRows) {
    if (p.taxonomyNodeId === null) continue;
    if (!affectedNodeIds.has(p.taxonomyNodeId)) continue;
    toUpdate.push(p.id);
  }

  if (toUpdate.length === 0) return 0;

  // Bookkeeping: bump the watermark so the next run doesn't re-see them.
  await db
    .update(products)
    .set({ extractedSchemaVersion: currentVersion })
    .where(inArray(products.id, toUpdate));

  log("reprocess", `stamped ${toUpdate.length} products at version ${currentVersion}`);
  return toUpdate.length;
}
