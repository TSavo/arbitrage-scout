/**
 * Iterate http_cache rows for LLM endpoints (Ollama generate, OpenRouter
 * chat completions). Try to extract+parse the inner text the same way the
 * pool does. Delete rows that fail. Leaves everything else alone.
 *
 * Safe to run while the scan is live — SQLite WAL permits concurrent reads
 * and deletes are per-row.
 */

import { eq, like, or } from "drizzle-orm";
import { db } from "@/db/client";
import { httpCache } from "@/db/schema";

const FENCE_RE = /```(?:json)?\s*([\s\S]+?)\s*```/i;
const OBJECT_RE = /(\{[\s\S]*\}|\[[\s\S]*\])/;
function parseJsonBlob(text: string): unknown {
  const trimmed = text.trim();
  const fence = FENCE_RE.exec(trimmed);
  if (fence) return JSON.parse(fence[1].trim());
  const obj = OBJECT_RE.exec(trimmed);
  if (obj) return JSON.parse(obj[1]);
  return JSON.parse(trimmed);
}

function extractOllama(raw: unknown): string {
  const d = raw as { response?: string };
  if (typeof d.response !== "string") throw new Error("no response field");
  return d.response;
}

function extractOpenRouter(raw: unknown): string {
  const d = raw as { choices?: Array<{ message?: { content?: string } }> };
  const content = d.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("no choices[0].message.content");
  return content;
}

async function main(): Promise<void> {
  const rows = await db
    .select({ id: httpCache.id, url: httpCache.url, body: httpCache.responseBody })
    .from(httpCache)
    .where(
      or(
        like(httpCache.url, "%/api/generate%"),
        like(httpCache.url, "%openrouter.ai/api/v1/chat/completions%"),
      ),
    );

  console.log(`scanning ${rows.length} LLM cache rows…`);
  let bad = 0;
  let ok = 0;
  for (const row of rows) {
    const isOllama = /\/api\/generate/.test(row.url);
    try {
      const outer = JSON.parse(row.body);
      const text = isOllama ? extractOllama(outer) : extractOpenRouter(outer);
      parseJsonBlob(text);
      ok++;
    } catch (err) {
      bad++;
      await db.delete(httpCache).where(eq(httpCache.id, row.id));
      console.log(
        `  DELETED id=${row.id} ${isOllama ? "ollama" : "openrouter"}: ${(err as Error).message.slice(0, 80)}`,
      );
    }
  }
  console.log(`\ndone. ok=${ok} bad_deleted=${bad}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
