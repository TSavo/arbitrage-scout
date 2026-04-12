import { db } from "@/db/client";
import { httpCache } from "@/db/schema";
import { sql } from "drizzle-orm";

async function main() {
  const [before] = await db.select({ n: sql<number>`count(*)` }).from(httpCache);
  await db.delete(httpCache);
  const [after] = await db.select({ n: sql<number>`count(*)` }).from(httpCache);
  console.log(`http_cache: ${before.n} → ${after.n}`);
}
main();
