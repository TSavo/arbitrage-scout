/**
 * Data migration: copy every table from the live SQLite DB to the
 * freshly-provisioned Postgres on battleaxe.
 *
 * Run this ONCE at cutover, after the scan is finished. It:
 *   1. Opens both DBs side by side.
 *   2. For each table (in FK-safe order), streams rows from SQLite and
 *      bulk-inserts them into Postgres in chunks.
 *   3. Resets each Postgres sequence so future auto-increments pick up
 *      where SQLite left off.
 *   4. Reports row counts per table for a sanity cross-check.
 *
 * Idempotent within a run (ON CONFLICT DO NOTHING). Destructive-ish in
 * aggregate — if you re-run without clearing pg, rows stay as-is but
 * sequences get reset to max+1 each time (harmless).
 *
 *   DATABASE_URL=postgres://... npx tsx scripts/migrate_to_pg.ts
 */

import Database from "better-sqlite3";
import postgres from "postgres";

const SQLITE_PATH = process.env.SQLITE_PATH || "data/scout-v2.db";
const PG_URL: string = (() => {
  const u = process.env.DATABASE_URL;
  if (!u) throw new Error("set DATABASE_URL to the target Postgres");
  return u;
})();

const CHUNK = 2_000;

/**
 * Migration order — children after parents so FKs resolve cleanly.
 * Each entry: sqlite table name, pg table name (usually same), and an
 * optional row transform for type coercion (SQLite 0/1 → pg TRUE/FALSE,
 * SQLite TEXT JSON → pg JSONB via JSON.parse).
 */
interface TableSpec {
  readonly name: string;
  readonly pg?: string;
  /** Column-level transforms; key is pg column name. */
  readonly transforms?: Record<string, (val: unknown) => unknown>;
  /** Boolean-valued columns in SQLite (stored as 0/1) — coerced to bool. */
  readonly booleans?: readonly string[];
  /** JSON-valued columns in SQLite (stored as text) — coerced to object. */
  readonly jsonb?: readonly string[];
  /** Table has its own id as SERIAL; after migration, reset seq. */
  readonly serialColumn?: string;
}

const TABLES: readonly TableSpec[] = [
  // No-FK leaves first.
  { name: "marketplaces", booleans: ["supports_api"] },

  // Taxonomy tree (self-FK).
  {
    name: "taxonomy_nodes",
    booleans: ["canonical"],
    serialColumn: "id",
  },
  {
    name: "taxonomy_node_fields",
    booleans: ["is_integer", "is_required", "is_searchable", "is_identifier", "is_pricing_axis", "is_hidden", "canonical"],
    serialColumn: "id",
  },
  {
    name: "taxonomy_node_field_enum_values",
    serialColumn: "id",
  },
  {
    name: "schema_versions",
    jsonb: ["payload"],
    serialColumn: "id",
  },

  // Products & friends.
  {
    name: "products",
    jsonb: ["metadata"],
    // products.id is text, no serial.
  },
  {
    name: "product_identifiers",
    serialColumn: "id",
  },
  {
    name: "price_points",
    jsonb: ["dimensions"],
    serialColumn: "id",
  },

  // Listings pipeline.
  {
    name: "listings",
    booleans: ["is_lot", "is_active"],
    serialColumn: "id",
  },
  {
    name: "listing_items",
    booleans: ["confirmed"],
    jsonb: ["condition_details", "raw_extraction"],
    serialColumn: "id",
  },
  {
    name: "opportunities",
    jsonb: ["flags"],
    serialColumn: "id",
  },

  // Watchlist / inventory.
  {
    name: "watchlist_items",
    booleans: ["active"],
    serialColumn: "id",
  },
  {
    name: "inventory_items",
    serialColumn: "id",
  },

  // Embeddings metadata (vectors handled separately below).
  {
    name: "embeddings",
    serialColumn: "id",
  },

  // Http cache (large — many MB of cached responses). Optional to skip.
  {
    name: "http_cache",
    serialColumn: "id",
  },

  // Scan logs.
  {
    name: "scan_logs",
    booleans: ["rate_limited"],
    serialColumn: "id",
  },
];

function coerceRow(row: Record<string, unknown>, spec: TableSpec): Record<string, unknown> {
  const out: Record<string, unknown> = { ...row };
  if (spec.booleans) {
    for (const col of spec.booleans) {
      if (col in out) {
        const v = out[col];
        out[col] = v === 1 || v === "1" || v === true;
      }
    }
  }
  if (spec.jsonb) {
    for (const col of spec.jsonb) {
      if (col in out) {
        const v = out[col];
        if (typeof v === "string") {
          try {
            out[col] = JSON.parse(v);
          } catch {
            // leave raw string; pg will reject, forcing us to fix
          }
        }
      }
    }
  }
  if (spec.transforms) {
    for (const [col, fn] of Object.entries(spec.transforms)) {
      if (col in out) out[col] = fn(out[col]);
    }
  }
  return out;
}

async function migrateTable(
  sqlite: Database.Database,
  sql: postgres.Sql,
  spec: TableSpec,
): Promise<{ rows: number; ms: number }> {
  const pgName = spec.pg ?? spec.name;
  const t0 = Date.now();
  const total = sqlite.prepare(`SELECT COUNT(*) AS n FROM ${spec.name}`).get() as { n: number };
  if (total.n === 0) {
    console.log(`  ${spec.name}: 0 rows (skipping)`);
    return { rows: 0, ms: 0 };
  }
  const stmt = sqlite.prepare(`SELECT * FROM ${spec.name}`);
  let inserted = 0;
  let buf: Record<string, unknown>[] = [];
  for (const raw of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
    buf.push(coerceRow(raw, spec));
    if (buf.length >= CHUNK) {
      await sql`INSERT INTO ${sql(pgName)} ${sql(buf)} ON CONFLICT DO NOTHING`;
      inserted += buf.length;
      buf = [];
      process.stdout.write(`\r  ${spec.name}: ${inserted}/${total.n}`);
    }
  }
  if (buf.length) {
    await sql`INSERT INTO ${sql(pgName)} ${sql(buf)} ON CONFLICT DO NOTHING`;
    inserted += buf.length;
  }
  // Reset sequence so future serial inserts don't collide.
  if (spec.serialColumn) {
    const seq = `${pgName}_${spec.serialColumn}_seq`;
    await sql.unsafe(`SELECT setval('${seq}', COALESCE((SELECT MAX(${spec.serialColumn}) FROM ${pgName}), 1))`);
  }
  const ms = Date.now() - t0;
  console.log(`\r  ${spec.name}: ${inserted}/${total.n} in ${(ms / 1000).toFixed(1)}s`);
  return { rows: inserted, ms };
}

async function migrateEmbeddings(
  sqlite: Database.Database,
  sql: postgres.Sql,
): Promise<void> {
  // sqlite-vec stores vectors in the vec_embeddings virtual table. Stream
  // them into pgvector's vec_embeddings native table.
  let hasVec: { n: number };
  try {
    hasVec = sqlite
      .prepare(`SELECT COUNT(*) AS n FROM vec_embeddings`)
      .get() as { n: number };
  } catch {
    console.log(`  vec_embeddings: source table missing, skipping`);
    return;
  }
  if (hasVec.n === 0) {
    console.log(`  vec_embeddings: 0 rows`);
    return;
  }
  console.log(`  vec_embeddings: copying ${hasVec.n} vectors…`);
  const stmt = sqlite.prepare(
    `SELECT entity_type, entity_id, embedding FROM vec_embeddings`,
  );
  let inserted = 0;
  let buf: Array<{ entity_type: string; entity_id: string; embedding: string }> = [];
  const t0 = Date.now();
  for (const row of stmt.iterate() as IterableIterator<{
    entity_type: string;
    entity_id: string;
    embedding: Buffer | Float32Array;
  }>) {
    // sqlite-vec stores as a binary float32 blob; convert to the pgvector
    // literal "[f1,f2,...]".
    const buf32 =
      row.embedding instanceof Float32Array
        ? row.embedding
        : new Float32Array(
            (row.embedding as Buffer).buffer,
            (row.embedding as Buffer).byteOffset,
            (row.embedding as Buffer).byteLength / 4,
          );
    const literal = `[${Array.from(buf32).join(",")}]`;
    buf.push({
      entity_type: row.entity_type,
      entity_id: row.entity_id,
      embedding: literal,
    });
    if (buf.length >= 500) {
      await sql`INSERT INTO vec_embeddings ${sql(buf)} ON CONFLICT DO NOTHING`;
      inserted += buf.length;
      buf = [];
      process.stdout.write(`\r  vec_embeddings: ${inserted}/${hasVec.n}`);
    }
  }
  if (buf.length) {
    await sql`INSERT INTO vec_embeddings ${sql(buf)} ON CONFLICT DO NOTHING`;
    inserted += buf.length;
  }
  const ms = Date.now() - t0;
  console.log(`\r  vec_embeddings: ${inserted}/${hasVec.n} in ${(ms / 1000).toFixed(1)}s`);
}

async function main() {
  console.log(`source: sqlite://${SQLITE_PATH}`);
  console.log(`target: ${PG_URL.replace(/:[^:@]+@/, ":***@")}`);
  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  try {
    const sqliteVec = require("sqlite-vec");
    sqliteVec.load(sqlite);
  } catch {
    // Without sqlite-vec, the vec_embeddings copy will just skip.
  }
  const sql = postgres(PG_URL, { max: 4 });

  try {
    let total = 0;
    const t0 = Date.now();
    for (const spec of TABLES) {
      const { rows } = await migrateTable(sqlite, sql, spec);
      total += rows;
    }
    await migrateEmbeddings(sqlite, sql);
    console.log(
      `\nmigration complete: ${total} rows across ${TABLES.length} tables in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
    );
  } finally {
    await sql.end({ timeout: 5 });
    sqlite.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
