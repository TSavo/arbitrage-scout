/**
 * Trigger the idempotent DDL bootstrap in client.pg.ts.
 */
import { pgReady, sql } from "@/db/client.pg";

async function main(): Promise<void> {
  await pgReady;
  console.log("pg bootstrap completed");
  await sql.end({ timeout: 5 });
}
main().catch((e) => { console.error(e); process.exit(1); });
