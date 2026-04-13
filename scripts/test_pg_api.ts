/**
 * Probe whether drizzle-orm/postgres-js supports .all() / .get() / .run()
 * or requires pure await. Determines rewrite pattern.
 */
import { db, pgReady } from "@/db/client.pg";
import { taxonomyNodes } from "@/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  await pgReady;

  // Pure await — known to work
  const a = await db.select().from(taxonomyNodes).limit(2);
  console.log("pure await:", a.length);

  // .all() — does it exist?
  try {
    // @ts-ignore
    const b = await db.select().from(taxonomyNodes).limit(2).all();
    console.log(".all() works:", b.length);
  } catch (e) {
    console.log(".all() fails:", (e as Error).message.slice(0, 120));
  }

  // .get() ?
  try {
    // @ts-ignore
    const c = await db.select().from(taxonomyNodes).limit(1).get();
    console.log(".get() works:", !!c);
  } catch (e) {
    console.log(".get() fails:", (e as Error).message.slice(0, 120));
  }

  // .run() on insert?
  try {
    // @ts-ignore
    await db.update(taxonomyNodes).set({ label: (await db.select().from(taxonomyNodes).limit(1).then(r=>r[0].label)) }).where(eq(taxonomyNodes.id, -9999)).run();
    console.log(".run() works");
  } catch (e) {
    console.log(".run() fails:", (e as Error).message.slice(0, 120));
  }

  process.exit(0);
}
main();
