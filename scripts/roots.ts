import { db } from "@/db/client";
import { taxonomyNodes } from "@/db/schema";
import { eq, isNull } from "drizzle-orm";

async function main() {
  const root = await db.query.taxonomyNodes.findFirst({
    where: isNull(taxonomyNodes.parentId),
  });
  if (!root) { console.log("no root"); return; }
  const kids = await db.query.taxonomyNodes.findMany({
    where: eq(taxonomyNodes.parentId, root.id),
  });
  console.log(`root children: ${kids.length}`);
  for (const k of kids) {
    console.log(`  ${k.canonical ? "✓" : "✗"}  ${k.slug}  obs=${k.observationCount}`);
  }
}
main();
