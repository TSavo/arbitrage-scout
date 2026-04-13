/**
 * Backfill Google Product Taxonomy refs into taxonomy_external_refs.
 *
 * Fetches the with-IDs GPT CSV (v2021-09-21), slugifies each label path to
 * our canonical form, and for every DB node whose path_cache matches, writes:
 *   - taxonomy_external_refs (source='google_gpt', external_id=gptId,
 *     external_path=labelPath, confidence=1.0)
 *   - taxonomy_nodes.gpt_id = gptId (if currently null)
 *
 * Reports matched/unmatched so we can see where our tree has drifted from
 * GPT and decide which divergences to keep (mezcal, japanese_whisky) vs fix.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { taxonomyNodes, taxonomyExternalRefs } from "@/db/schema";

const GPT_URL = "https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt";

function slugifySegment(seg: string): string {
  return seg
    .toLowerCase()
    .replace(/[&,'’"]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function slugifyPath(labelPath: string): string {
  return "/" + labelPath.split(" > ").map(slugifySegment).join("/");
}

interface GptEntry {
  readonly id: string;
  readonly labelPath: string;
  readonly slugPath: string;
}

async function fetchGpt(): Promise<GptEntry[]> {
  const resp = await fetch(GPT_URL);
  if (!resp.ok) throw new Error(`GPT fetch ${resp.status}`);
  const text = await resp.text();
  const entries: GptEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(/^(\d+)\s*-\s*(.+)$/);
    if (!m) continue;
    const id = m[1];
    const labelPath = m[2].trim();
    const slugPath = slugifyPath(labelPath);
    entries.push({ id, labelPath, slugPath });
  }
  return entries;
}

async function main(): Promise<void> {
  console.log(`fetching GPT with-IDs…`);
  const gpt = await fetchGpt();
  console.log(`parsed ${gpt.length} GPT entries`);

  const byPath = new Map(gpt.map((e) => [e.slugPath, e]));

  const nodes = await db.select({ id: taxonomyNodes.id, path: taxonomyNodes.pathCache, gptId: taxonomyNodes.gptId }).from(taxonomyNodes);
  console.log(`checking ${nodes.length} DB nodes…\n`);

  const now = new Date().toISOString();
  let matched = 0;
  let alreadyRef = 0;
  let gptIdBackfilled = 0;
  const unmatchedSample: string[] = [];

  for (const node of nodes) {
    const hit = byPath.get(node.path);
    if (!hit) {
      if (unmatchedSample.length < 30) unmatchedSample.push(node.path);
      continue;
    }
    matched++;

    // Upsert external ref
    const existing = await db
      .select({ id: taxonomyExternalRefs.id })
      .from(taxonomyExternalRefs)
      .where(sql`${taxonomyExternalRefs.nodeId} = ${node.id} AND ${taxonomyExternalRefs.source} = 'google_gpt'`)
      .limit(1);
    if (existing.length > 0) {
      alreadyRef++;
    } else {
      await db.insert(taxonomyExternalRefs).values({
        nodeId: node.id,
        source: "google_gpt",
        externalId: hit.id,
        externalPath: hit.labelPath,
        confidence: 1.0,
        createdAt: now,
      });
    }

    // Backfill legacy gpt_id on taxonomy_nodes if null
    if (!node.gptId) {
      await db.update(taxonomyNodes)
        .set({ gptId: hit.id })
        .where(eq(taxonomyNodes.id, node.id));
      gptIdBackfilled++;
    }
  }

  console.log(`matched ${matched}/${nodes.length} nodes`);
  console.log(`  new refs inserted: ${matched - alreadyRef}`);
  console.log(`  refs already present: ${alreadyRef}`);
  console.log(`  gpt_id column backfilled: ${gptIdBackfilled}`);
  console.log(`\nunmatched sample (first ${unmatchedSample.length}):`);
  for (const p of unmatchedSample) console.log(`  ${p}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
