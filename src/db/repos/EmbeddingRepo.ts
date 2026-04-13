import { and, eq, isNull, sql, inArray } from "drizzle-orm";
import { db } from "../client";
import { embeddings, products } from "../schema";
import { cachedFetch } from "@/lib/cached_fetch";
import { log, error } from "@/lib/logger";

/**
 * Compute a single 4096-dim embedding. Tries Ollama first (free, local GPU);
 * on timeout or error, falls back to OpenRouter's qwen/qwen3-embedding-8b,
 * which returns the same dimension so existing stored vectors remain
 * compatible. OpenRouter bills ~$0.00000011 per call — trivial.
 */
// Circuit breaker: after CB_FAIL_THRESHOLD consecutive Ollama failures, skip
// Ollama entirely for CB_COOLDOWN_MS. Every failed Ollama attempt was costing
// 1–3s of wall time before the fallback kicked in; after a few of those in
// a row it's cheaper to jump straight to OpenRouter until Ollama recovers.
const CB_FAIL_THRESHOLD = 3;
const CB_COOLDOWN_MS = 60_000;
let ollamaConsecutiveFails = 0;
let ollamaSkipUntil = 0;

async function computeEmbedding(
  text: string,
  ollamaUrl: string,
): Promise<number[] | null> {
  const now = Date.now();
  if (now >= ollamaSkipUntil) {
    const t0 = now;
    try {
      const resp = await cachedFetch(
        `${ollamaUrl}/api/embed`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "qwen3-embedding:8b", input: text }),
        },
        { ttlMs: null, cacheTag: "embed", networkTimeoutMs: 60_000, maxRetries: 1 },
      );
      if (resp.ok) {
        const vec = resp.json<{ embeddings?: number[][] }>().embeddings?.[0];
        if (vec?.length) {
          ollamaConsecutiveFails = 0;
          log("embedding", `ollama ok dim=${vec.length} ${Date.now() - t0}ms`);
          return vec;
        }
      }
      ollamaConsecutiveFails++;
      error("embedding", `ollama bad response (${resp.status}) ${Date.now() - t0}ms fails=${ollamaConsecutiveFails}`);
    } catch (err) {
      ollamaConsecutiveFails++;
      error("embedding", `ollama failed after ${Date.now() - t0}ms (${(err as Error).message}) fails=${ollamaConsecutiveFails}`);
    }
    if (ollamaConsecutiveFails >= CB_FAIL_THRESHOLD) {
      ollamaSkipUntil = Date.now() + CB_COOLDOWN_MS;
      log("embedding", `ollama circuit opened — skipping for ${CB_COOLDOWN_MS / 1000}s`);
    }
  }

  const orKey = process.env.OPENROUTER_API_KEY;
  if (!orKey) {
    error("embedding", "no OPENROUTER_API_KEY — cannot fall back");
    return null;
  }
  const t1 = Date.now();
  try {
    const resp = await cachedFetch(
      "https://openrouter.ai/api/v1/embeddings",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${orKey}`,
          "HTTP-Referer": "https://arbitrage-scout.local",
          "X-Title": "arbitrage-scout",
        },
        body: JSON.stringify({ model: "qwen/qwen3-embedding-8b", input: text }),
      },
      { ttlMs: null, cacheTag: "embed-or", networkTimeoutMs: 30_000, maxRetries: 2 },
    );
    if (!resp.ok) {
      error("embedding", `openrouter ${resp.status} ${Date.now() - t1}ms: ${resp.body.slice(0, 120)}`);
      return null;
    }
    const data = resp.json<{ data?: Array<{ embedding: number[] }> }>();
    const vec = data.data?.[0]?.embedding;
    if (!vec?.length) {
      error("embedding", `openrouter returned no vector ${Date.now() - t1}ms`);
      return null;
    }
    log("embedding", `openrouter ok dim=${vec.length} ${Date.now() - t1}ms`);
    return vec;
  } catch (err) {
    error("embedding", `openrouter failed after ${Date.now() - t1}ms`, err);
    return null;
  }
}

function floatsToBuffer(vec: number[]): Buffer {
  const buf = Buffer.alloc(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

function bufferToFloats(buf: Buffer): number[] {
  const n = buf.length / 4;
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push(buf.readFloatLE(i * 4));
  return out;
}

/** Parse a pgvector text-form literal "[1.0,2.0,...]" into a number[]. */
function parsePgvectorLiteral(literal: string): number[] {
  // Strip brackets and split.
  const inner = literal.replace(/^\[|\]$/g, "");
  if (!inner) return [];
  return inner.split(",").map((s) => Number(s));
}

export type EntityType = "product" | "listing";

/**
 * Embedding repository.
 *
 * Two tables, one purpose:
 * - `embeddings` (Drizzle) — metadata registry: what's been embedded, when
 * - `vec_embeddings` (sqlite-vec) — the actual vectors for similarity search
 *
 * The Drizzle table has NO blob. The vector lives only in sqlite-vec.
 * This repo is the only thing that touches either table.
 */
export class EmbeddingRepo {
  /** Check if an entity has been embedded. */
  async exists(entityType: EntityType, entityId: string): Promise<boolean> {
    const row = await db.query.embeddings.findFirst({
      where: and(
        eq(embeddings.entityType, entityType),
        eq(embeddings.entityId, entityId),
      ),
      columns: { id: true },
    });
    return !!row;
  }

  /** Get the embedding vector for an entity from pgvector. */
  async get(entityType: EntityType, entityId: string): Promise<number[] | null> {
    try {
      const rows = await db.execute<{ embedding: string }>(
        sql`SELECT embedding::text AS embedding FROM vec_embeddings
            WHERE entity_type = ${entityType} AND entity_id = ${entityId}`
      );
      if (!rows.length) return null;
      // pgvector text format: "[1.0,2.0,...]"
      const literal = rows[0].embedding;
      return parsePgvectorLiteral(literal);
    } catch {
      return null;
    }
  }

  /** Store an embedding. Writes metadata to Drizzle, vector to pgvector. */
  async set(entityType: EntityType, entityId: string, vec: number[]): Promise<void> {
    const now = new Date().toISOString();
    const literal = `[${vec.join(",")}]`;

    // Metadata registry (no blob)
    await db
      .insert(embeddings)
      .values({ entityType, entityId, embeddedAt: now })
      .onConflictDoUpdate({
        target: [embeddings.entityType, embeddings.entityId],
        set: { embeddedAt: now },
      });

    // Vector storage — pgvector accepts the "[...]" literal as a vector cast.
    try {
      await db.execute(sql`
        INSERT INTO vec_embeddings(entity_type, entity_id, embedding)
        VALUES (${entityType}, ${entityId}, ${literal}::vector)
        ON CONFLICT (entity_type, entity_id) DO UPDATE
          SET embedding = EXCLUDED.embedding
      `);
    } catch (err) {
      error("embedding", `pgvector insert failed for ${entityType}:${entityId}: ${err}`);
    }
  }

  /** Get or compute a single embedding via Ollama. */
  async getOrCompute(
    entityType: EntityType,
    entityId: string,
    text: string,
    ollamaUrl = "http://battleaxe:11434",
  ): Promise<number[] | null> {
    const existing = await this.exists(entityType, entityId);
    if (existing) return this.get(entityType, entityId);

    log("embedding", `MISS ${entityType}:${entityId} — computing`);
    const vec = await computeEmbedding(text, ollamaUrl);
    if (!vec) return null;
    await this.set(entityType, entityId, vec);
    return vec;
  }

  /**
   * Batch embed multiple entities in a single Ollama request.
   * Skips already-embedded entities. Returns count of newly embedded.
   */
  async batchEmbed(
    entityType: EntityType,
    items: { id: string; text: string }[],
    ollamaUrl = "http://battleaxe:11434",
  ): Promise<number> {
    // Check which are already embedded (single query, not N+1)
    const ids = items.map((i) => i.id);
    const existingRows = await db
      .select({ entityId: embeddings.entityId })
      .from(embeddings)
      .where(and(eq(embeddings.entityType, entityType), inArray(embeddings.entityId, ids)));
    const existingIds = new Set(existingRows.map((r) => r.entityId));

    const uncached = items.filter((i) => !existingIds.has(i.id));
    if (uncached.length === 0) return 0;

    const t0 = Date.now();
    try {
      const resp = await cachedFetch(
        `${ollamaUrl}/api/embed`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "qwen3-embedding:8b",
            input: uncached.map((u) => u.text),
          }),
        },
        { ttlMs: null, cacheTag: "embed-batch", networkTimeoutMs: 120_000 },
      );
      if (!resp.ok) {
        error("embedding", `Ollama batch ${resp.status} after ${Date.now() - t0}ms`);
        return 0;
      }
      const data = resp.json<{ embeddings?: number[][] }>();
      const vecs = data.embeddings;
      if (!vecs || vecs.length !== uncached.length) {
        error("embedding", `Ollama returned ${vecs?.length ?? 0} vecs for ${uncached.length} inputs`);
        return 0;
      }

      // Write all at once
      const now = new Date().toISOString();
      for (let i = 0; i < uncached.length; i++) {
        await this.set(entityType, uncached[i].id, vecs[i]);
      }

      log("embedding", `batch ${uncached.length} ${entityType}s in ${Date.now() - t0}ms`);
      return uncached.length;
    } catch (err) {
      error("embedding", `Ollama batch failed after ${Date.now() - t0}ms`, err);
      return 0;
    }
  }

  /** Count embeddings by entity type. */
  async count(entityType?: EntityType): Promise<number> {
    const conditions = entityType ? eq(embeddings.entityType, entityType) : undefined;
    const rows = await db
      .select({ cnt: sql<number>`count(*)` })
      .from(embeddings)
      .where(conditions);
    return rows[0]?.cnt ?? 0;
  }

  /**
   * Find the most similar entities using pgvector cosine distance.
   * `<=>` is the cosine-distance operator.
   */
  async findSimilar(
    entityType: EntityType,
    queryVec: number[],
    limit = 10,
  ): Promise<Array<{ entityId: string; distance: number }>> {
    try {
      const literal = `[${queryVec.join(",")}]`;
      const rows = await db.execute<{ entity_id: string; distance: number }>(
        sql`SELECT entity_id, embedding <=> ${literal}::vector AS distance
            FROM vec_embeddings
            WHERE entity_type = ${entityType}
            ORDER BY embedding <=> ${literal}::vector
            LIMIT ${limit}`
      );
      return rows.map((r) => ({ entityId: r.entity_id, distance: r.distance }));
    } catch (err) {
      error("embedding", `pgvector search failed: ${err}`);
      return [];
    }
  }

  /** Find product IDs that don't have embeddings yet. */
  async findUnembeddedProducts(limit?: number): Promise<string[]> {
    const rows = await db
      .select({ id: products.id })
      .from(products)
      .leftJoin(
        embeddings,
        and(
          eq(embeddings.entityType, "product"),
          eq(embeddings.entityId, products.id),
        ),
      )
      .where(isNull(embeddings.id))
      .limit(limit ?? 1000);
    return rows.map((r) => r.id);
  }
}

export const embeddingRepo = new EmbeddingRepo();
