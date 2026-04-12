import { and, eq, lt, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { db } from "../client";
import { httpCache } from "../schema";

export interface CachedResponse {
  readonly status: number;
  readonly body: string;
  readonly contentType: string | null;
  readonly fetchedAt: string;
  readonly expiresAt: string | null;
}

export interface CacheLookupKey {
  readonly method: string;
  readonly url: string;
  readonly body?: string | null;
}

function hashBody(body: string | null | undefined): string {
  if (!body) return "-";
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

function fingerprint(key: CacheLookupKey): string {
  const bh = hashBody(key.body);
  return createHash("sha256")
    .update(`${key.method.toUpperCase()}|${key.url}|${bh}`)
    .digest("hex");
}

export class HttpCacheRepo {
  async lookup(key: CacheLookupKey): Promise<CachedResponse | null> {
    const fp = fingerprint(key);
    const row = await db.query.httpCache.findFirst({
      where: eq(httpCache.fingerprint, fp),
    });
    if (!row) return null;
    if (row.expiresAt && row.expiresAt <= new Date().toISOString()) {
      return null;
    }
    // Fire-and-forget hit counter bump.
    db.update(httpCache)
      .set({ hits: sql`${httpCache.hits} + 1` })
      .where(eq(httpCache.id, row.id))
      .catch(() => {});
    return Object.freeze({
      status: row.status,
      body: row.responseBody,
      contentType: row.contentType,
      fetchedAt: row.fetchedAt,
      expiresAt: row.expiresAt,
    });
  }

  async store(params: {
    readonly method: string;
    readonly url: string;
    readonly body?: string | null;
    readonly status: number;
    readonly responseBody: string;
    readonly contentType?: string | null;
    readonly ttlMs?: number | null;
  }): Promise<void> {
    const now = new Date();
    const fp = fingerprint({
      method: params.method,
      url: params.url,
      body: params.body,
    });
    const expiresAt =
      params.ttlMs == null
        ? null
        : new Date(now.getTime() + params.ttlMs).toISOString();

    await db
      .insert(httpCache)
      .values({
        fingerprint: fp,
        method: params.method.toUpperCase(),
        url: params.url,
        bodyHash: hashBody(params.body),
        status: params.status,
        responseBody: params.responseBody,
        contentType: params.contentType ?? null,
        fetchedAt: now.toISOString(),
        expiresAt,
        hits: 0,
      })
      .onConflictDoUpdate({
        target: httpCache.fingerprint,
        set: {
          status: params.status,
          responseBody: params.responseBody,
          contentType: params.contentType ?? null,
          fetchedAt: now.toISOString(),
          expiresAt,
          hits: 0,
        },
      });
  }

  async purgeExpired(): Promise<number> {
    const nowIso = new Date().toISOString();
    const res = await db
      .delete(httpCache)
      .where(and(lt(httpCache.expiresAt, nowIso)));
    return (res as { changes?: number }).changes ?? 0;
  }

  async stats(): Promise<{
    readonly rows: number;
    readonly totalHits: number;
  }> {
    const [row] = await db
      .select({
        rows: sql<number>`count(*)`,
        totalHits: sql<number>`coalesce(sum(${httpCache.hits}), 0)`,
      })
      .from(httpCache);
    return { rows: row.rows, totalHits: row.totalHits };
  }
}

export const httpCacheRepo = new HttpCacheRepo();
