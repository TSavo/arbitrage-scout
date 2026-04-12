import { and, eq, isNull, sql, inArray } from "drizzle-orm";
import { db } from "../client";
import { embeddings, products } from "../schema";
import { cachedFetch } from "@/lib/cached_fetch";
import { log, error } from "@/lib/logger";

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

  /** Get the embedding vector for an entity from sqlite-vec. */
  async get(entityType: EntityType, entityId: string): Promise<number[] | null> {
    try {
      const rows = db.all<{ embedding: Buffer }>(
        sql`SELECT embedding FROM vec_embeddings
            WHERE entity_type = ${entityType} AND entity_id = ${entityId}`
      );
      if (!rows.length) return null;
      return bufferToFloats(rows[0].embedding);
    } catch {
      return null;
    }
  }

  /** Store an embedding. Writes metadata to Drizzle, vector to sqlite-vec. */
  async set(entityType: EntityType, entityId: string, vec: number[]): Promise<void> {
    const now = new Date().toISOString();
    const buf = floatsToBuffer(vec);

    // Metadata registry (no blob)
    await db
      .insert(embeddings)
      .values({ entityType, entityId, embeddedAt: now })
      .onConflictDoUpdate({
        target: [embeddings.entityType, embeddings.entityId],
        set: { embeddedAt: now },
      });

    // Vector storage
    try {
      db.run(sql`INSERT OR REPLACE INTO vec_embeddings(entity_type, entity_id, embedding)
                  VALUES (${entityType}, ${entityId}, ${buf})`);
    } catch (err) {
      error("embedding", `vec insert failed for ${entityType}:${entityId}: ${err}`);
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

    log("embedding", `MISS ${entityType}:${entityId} — calling Ollama`);
    const t0 = Date.now();
    try {
      const resp = await cachedFetch(
        `${ollamaUrl}/api/embed`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "qwen3-embedding:8b", input: text }),
        },
        { ttlMs: null, cacheTag: "embed" },
      );
      if (!resp.ok) {
        error("embedding", `Ollama ${resp.status} after ${Date.now() - t0}ms`);
        return null;
      }
      const data = resp.json<{ embeddings?: number[][] }>();
      const vec = data.embeddings?.[0];
      if (!vec?.length) {
        error("embedding", `Ollama returned no vector after ${Date.now() - t0}ms`);
        return null;
      }
      await this.set(entityType, entityId, vec);
      log("embedding", `computed ${entityType}:${entityId} dim=${vec.length} ${Date.now() - t0}ms`);
      return vec;
    } catch (err) {
      error("embedding", `Ollama failed after ${Date.now() - t0}ms`, err);
      return null;
    }
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
        { ttlMs: null, cacheTag: "embed-batch" },
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
   * Find the most similar entities using sqlite-vec.
   * Vector search at the DB level — zero memory overhead.
   */
  async findSimilar(
    entityType: EntityType,
    queryVec: number[],
    limit = 10,
  ): Promise<Array<{ entityId: string; distance: number }>> {
    try {
      const buf = floatsToBuffer(queryVec);
      const rows = db.all<{ entity_id: string; distance: number }>(
        sql`SELECT entity_id, distance
            FROM vec_embeddings
            WHERE entity_type = ${entityType}
              AND embedding MATCH ${buf}
              AND k = ${limit}
            ORDER BY distance`
      );
      return rows.map((r) => ({ entityId: r.entity_id, distance: r.distance }));
    } catch (err) {
      error("embedding", `sqlite-vec search failed: ${err}`);
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
