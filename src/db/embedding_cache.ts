/**
 * Universal embedding cache. Any text we embed gets stored by hash.
 * Products, listings, queries — compute once, read forever.
 */

import { createHash } from "crypto";
import { log, error } from "@/lib/logger";

const EMBEDDING_DIM = 4096;

function textHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
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

export function initEmbeddingCache(sqlite: any): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      text_hash TEXT PRIMARY KEY,
      text_preview TEXT NOT NULL,
      embedding BLOB NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
}

export function getCachedEmbedding(sqlite: any, text: string): number[] | null {
  const hash = textHash(text);
  const row = sqlite.prepare(
    "SELECT embedding FROM embedding_cache WHERE text_hash = ?",
  ).get(hash) as { embedding: Buffer } | undefined;
  if (row) {
    return bufferToFloats(row.embedding);
  }
  return null;
}

export function cacheEmbedding(sqlite: any, text: string, vec: number[]): void {
  const hash = textHash(text);
  const preview = text.slice(0, 100);
  sqlite.prepare(
    "INSERT OR IGNORE INTO embedding_cache (text_hash, text_preview, embedding) VALUES (?, ?, ?)",
  ).run(hash, preview, floatsToBuffer(vec));
}

/**
 * Get or compute an embedding. Checks cache first, calls Ollama if miss.
 * Always stores the result.
 */
export function getOrComputeEmbedding(
  sqlite: any,
  text: string,
  ollamaUrl = "http://battleaxe:11434",
): number[] | null {
  // Cache hit?
  const cached = getCachedEmbedding(sqlite, text);
  if (cached) {
    log("embedding", `cache HIT: "${text.slice(0, 50)}..."`);
    return cached;
  }

  // Cache miss — compute via Ollama
  log("embedding", `cache MISS: "${text.slice(0, 50)}..." — calling Ollama`);
  const t0 = Date.now();
  try {
    const { execSync } = require("child_process");
    const result = execSync(
      `curl -s -X POST ${ollamaUrl}/api/embed -d '${JSON.stringify({
        model: "qwen3-embedding:8b",
        input: text,
      }).replace(/'/g, "'\\''")}'`,
      { encoding: "utf8", timeout: 30000 },
    );
    const parsed = JSON.parse(result);
    const vec = parsed.embeddings?.[0];
    if (!vec || !vec.length) {
      error("embedding", `Ollama returned no vector after ${Date.now() - t0}ms`);
      return null;
    }

    // Store in cache
    cacheEmbedding(sqlite, text, vec);
    log("embedding", `computed + cached dim=${vec.length} elapsed=${Date.now() - t0}ms`);
    return vec;
  } catch (err) {
    error("embedding", `Ollama call failed after ${Date.now() - t0}ms`, err);
    return null;
  }
}

export function cacheStats(sqlite: any): { count: number; sizeBytes: number } {
  const row = sqlite.prepare(
    "SELECT COUNT(*) as count, SUM(LENGTH(embedding)) as size FROM embedding_cache",
  ).get() as { count: number; size: number };
  return { count: row.count, sizeBytes: row.size ?? 0 };
}
