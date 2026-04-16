import { db, pgReady } from "@/db/client.pg";
import { sql } from "drizzle-orm";

async function main() {
  await pgReady;
  try {
    const result = await db.execute(sql`
      SELECT parent.id, parent.label, parent.slug, parent.path_cache,
        COUNT(DISTINCT p.id) as product_count
      FROM taxonomy_nodes parent
      LEFT JOIN taxonomy_nodes child
        ON child.path_cache = parent.path_cache
        OR child.path_cache LIKE parent.path_cache || '/%'
      LEFT JOIN products p ON p.taxonomy_node_id = child.id
      WHERE parent.parent_id = (SELECT id FROM taxonomy_nodes WHERE parent_id IS NULL)
      GROUP BY parent.id, parent.label, parent.slug, parent.path_cache
      ORDER BY COUNT(DISTINCT p.id) DESC
      LIMIT 5
    `);
    console.log("type:", typeof result);
    console.log("isArray:", Array.isArray(result));
    console.log("length:", result.length);
    console.log("keys:", result.length > 0 ? Object.keys(result[0]) : "empty");
    console.log("first row:", result[0]);
  } catch (e) {
    console.error("ERROR:", e);
  }
  process.exit(0);
}
main();
