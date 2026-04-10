/**
 * Vector embeddings for semantic product search.
 *
 * Uses sqlite-vec for storage in the same DB file.
 * Uses qwen3-embedding:8b on Ollama for generation.
 *
 * sqlite-vec must be installed as a native addon and loaded at runtime
 * via the raw better-sqlite3 connection (not through Drizzle).
 */

import { sqlite } from "../db/client";
import { embed } from "./client";

const EMBEDDING_DIM = 4096;

// ── Binary packing ────────────────────────────────────────────────────

function floatsToBuffer(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) {
    buf.writeFloatLE(vec[i], i * 4);
  }
  return buf;
}

function bufferToFloats(buf: Buffer): number[] {
  const out: number[] = [];
  for (let i = 0; i < buf.length; i += 4) {
    out.push(buf.readFloatLE(i));
  }
  return out;
}

// ── sqlite-vec loader ─────────────────────────────────────────────────

let vecLoaded = false;

function loadVec(): void {
  if (vecLoaded) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteVec = require("sqlite-vec") as { load: (db: unknown) => void };
    // better-sqlite3 exposes loadExtension — sqlite-vec's load() calls it
    (sqlite as unknown as { loadExtension: (path: string) => void }).loadExtension;
    sqliteVec.load(sqlite);
    vecLoaded = true;
  } catch (err) {
    throw new Error(
      `sqlite-vec is not installed or could not be loaded. ` +
        `Install it with: npm install sqlite-vec\n${String(err)}`,
    );
  }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Create the vec0 virtual table if it doesn't exist.
 * Must be called before any embedding or search operations.
 */
export function initVecTable(db: typeof sqlite): void {
  loadVec();
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS product_embeddings ` +
      `USING vec0(product_id TEXT PRIMARY KEY, embedding float[${EMBEDDING_DIM}])`,
  );
}

export interface EmbedProductsOpts {
  ollamaUrl?: string;
  batchSize?: number;
}

/**
 * Generate and store embeddings for all products that don't have one yet.
 * Returns the number of newly embedded products.
 */
export async function embedProducts(
  db: typeof sqlite,
  opts: EmbedProductsOpts = {},
): Promise<number> {
  const { batchSize = 50 } = opts;

  initVecTable(db);

  // Products already embedded
  const existing = new Set<string>(
    (() => {
      try {
        return (
          db.prepare("SELECT product_id FROM product_embeddings").all() as Array<{
            product_id: string;
          }>
        ).map((r) => r.product_id);
      } catch {
        return [];
      }
    })(),
  );

  // All products from catalog
  const allProducts = db
    .prepare("SELECT id, title, platform FROM products")
    .all() as Array<{ id: string; title: string; platform: string | null }>;

  const toEmbed = allProducts.filter((p) => !existing.has(p.id));
  if (toEmbed.length === 0) return 0;

  const insert = db.prepare(
    "INSERT OR REPLACE INTO product_embeddings(product_id, embedding) VALUES (?, ?)",
  );

  let embedded = 0;

  for (let i = 0; i < toEmbed.length; i += batchSize) {
    const batch = toEmbed.slice(i, i + batchSize);

    const insertMany = db.transaction(
      (rows: Array<{ id: string; vec: Buffer }>) => {
        for (const row of rows) {
          insert.run(row.id, row.vec);
        }
      },
    );

    const results: Array<{ id: string; vec: Buffer }> = [];

    for (const product of batch) {
      const text = `${product.title} ${product.platform ?? ""}`.trim();
      try {
        const vec = await embed(text);
        results.push({ id: product.id, vec: floatsToBuffer(vec) });
      } catch (err) {
        console.warn(`[embeddings] failed to embed product ${product.id}: ${String(err)}`);
      }
    }

    if (results.length > 0) {
      insertMany(results);
      embedded += results.length;
    }
  }

  return embedded;
}

export interface SimilarProduct {
  productId: string;
  title: string;
  platform: string | null;
  distance: number;
}

export interface SearchSimilarOpts {
  limit?: number;
}

/**
 * Find products most semantically similar to a query string.
 * Returns results ordered by similarity (lowest distance = most similar).
 */
export async function searchSimilar(
  db: typeof sqlite,
  query: string,
  opts: SearchSimilarOpts = {},
): Promise<SimilarProduct[]> {
  const { limit = 10 } = opts;

  loadVec();

  const queryVec = await embed(query);
  const queryBuf = floatsToBuffer(queryVec);

  const rows = db
    .prepare(
      `SELECT pe.product_id, p.title, p.platform, pe.distance
       FROM product_embeddings pe
       JOIN products p ON p.id = pe.product_id
       WHERE pe.embedding MATCH ?
         AND k = ?
       ORDER BY pe.distance`,
    )
    .all(queryBuf, limit) as Array<{
    product_id: string;
    title: string;
    platform: string | null;
    distance: number;
  }>;

  return rows.map((r) => ({
    productId: r.product_id,
    title: r.title,
    platform: r.platform,
    distance: r.distance,
  }));
}
