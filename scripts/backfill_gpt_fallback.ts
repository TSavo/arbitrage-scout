/**
 * Step 2b — ancestor-fallback + explicit aliases.
 *
 * For every DB node missing a google_gpt ref, walk its path upward and
 * attach the first GPT match with confidence=0.85 (rollup — for feed
 * export semantics). Also apply explicit path aliases where our slug has
 * drifted from GPT's naming.
 *
 * Idempotent: skips nodes that already have a google_gpt ref.
 */

import { eq, and } from "drizzle-orm";
import { db } from "@/db/client";
import { taxonomyNodes, taxonomyExternalRefs } from "@/db/schema";

const GPT_URL = "https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt";

// Explicit aliases — our path left, GPT path right. Applied before fallback.
const ALIASES: Record<string, string> = {
  "/office_products": "/office_supplies",
  "/office_products/writing_instruments": "/office_supplies/office_instruments/writing_drawing_instruments",
  "/office_products/writing_instruments/fountain_pens": "/office_supplies/office_instruments/writing_drawing_instruments/pens_pencils/pens",
  "/office_products/writing_instruments/rollerball_pens": "/office_supplies/office_instruments/writing_drawing_instruments/pens_pencils/pens",
  "/office_products/writing_instruments/ballpoint_pens": "/office_supplies/office_instruments/writing_drawing_instruments/pens_pencils/pens",
  "/office_products/writing_supplies": "/office_supplies/office_instruments/writing_drawing_instruments",
  "/office_products/writing_supplies/bottled_ink": "/office_supplies/office_instruments/writing_drawing_instruments/pens_pencils/pens",
  "/office_products/writing_supplies/ink_samples": "/office_supplies/office_instruments/writing_drawing_instruments/pens_pencils/pens",
  "/collectibles": "/arts_entertainment/hobbies_creative_arts/collectibles",
  "/collectibles/coins": "/arts_entertainment/hobbies_creative_arts/collectibles/collectible_coins",
  "/collectibles/trading_cards": "/arts_entertainment/hobbies_creative_arts/collectibles/collectible_trading_cards",
  "/collectibles/comic_books": "/arts_entertainment/hobbies_creative_arts/collectibles/autographs",
  "/collectibles/comic_magazines": "/arts_entertainment/hobbies_creative_arts/collectibles/autographs",
  "/collectibles/figures": "/arts_entertainment/hobbies_creative_arts/collectibles",
  "/collectibles/figures/funko_pop": "/arts_entertainment/hobbies_creative_arts/collectibles",
};

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

interface GptEntry { readonly id: string; readonly labelPath: string; readonly slugPath: string; }

async function fetchGpt(): Promise<GptEntry[]> {
  const resp = await fetch(GPT_URL);
  if (!resp.ok) throw new Error(`GPT fetch ${resp.status}`);
  const text = await resp.text();
  const out: GptEntry[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(/^(\d+)\s*-\s*(.+)$/);
    if (!m) continue;
    out.push({ id: m[1], labelPath: m[2].trim(), slugPath: slugifyPath(m[2].trim()) });
  }
  return out;
}

function* ancestors(path: string): Generator<string> {
  const parts = path.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) {
    yield "/" + parts.slice(0, i).join("/");
  }
}

async function main(): Promise<void> {
  const gpt = await fetchGpt();
  const byPath = new Map(gpt.map((e) => [e.slugPath, e]));
  console.log(`GPT entries: ${gpt.length}, aliases: ${Object.keys(ALIASES).length}`);

  const nodes = await db.select({ id: taxonomyNodes.id, path: taxonomyNodes.pathCache }).from(taxonomyNodes);
  const now = new Date().toISOString();

  let exact = 0;
  let alias = 0;
  let ancestor = 0;
  let stillUnmatched = 0;
  const unmatched: string[] = [];

  for (const node of nodes) {
    // Skip if already has a google_gpt ref
    const existing = await db
      .select({ id: taxonomyExternalRefs.id })
      .from(taxonomyExternalRefs)
      .where(and(eq(taxonomyExternalRefs.nodeId, node.id), eq(taxonomyExternalRefs.source, "google_gpt")))
      .limit(1);
    if (existing.length > 0) { exact++; continue; }

    // 1. Check alias
    const aliasPath = ALIASES[node.path];
    if (aliasPath) {
      const hit = byPath.get(aliasPath);
      if (hit) {
        await db.insert(taxonomyExternalRefs).values({
          nodeId: node.id, source: "google_gpt",
          externalId: hit.id, externalPath: hit.labelPath,
          confidence: 0.95, createdAt: now,
        });
        alias++;
        continue;
      }
    }

    // 2. Ancestor fallback — walk up node.path and also up any matched alias path
    let matched: GptEntry | undefined;
    for (const anc of ancestors(node.path)) {
      matched = byPath.get(anc);
      if (matched) break;
      // Check if alias exists for ancestor
      const aAlias = ALIASES[anc];
      if (aAlias) {
        matched = byPath.get(aAlias);
        if (matched) break;
      }
    }
    if (matched) {
      await db.insert(taxonomyExternalRefs).values({
        nodeId: node.id, source: "google_gpt",
        externalId: matched.id, externalPath: matched.labelPath,
        confidence: 0.85, createdAt: now,
      });
      ancestor++;
    } else {
      stillUnmatched++;
      if (unmatched.length < 20) unmatched.push(node.path);
    }
  }

  console.log(`\nresults over ${nodes.length} nodes:`);
  console.log(`  exact (from step 2): ${exact}`);
  console.log(`  alias rule:          ${alias}`);
  console.log(`  ancestor fallback:   ${ancestor}`);
  console.log(`  still unmatched:     ${stillUnmatched}`);
  if (unmatched.length) {
    console.log(`\nunmatched sample:`);
    for (const p of unmatched) console.log(`  ${p}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
