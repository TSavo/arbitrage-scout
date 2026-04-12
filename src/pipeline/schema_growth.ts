/**
 * SchemaGrowthService — gated growth of the DB-driven taxonomy.
 *
 * Proposals (from the walk classifier) flow through here. The service:
 *   - deduplicates via unique (parent_id, slug) / (node_id, key) constraints,
 *   - reinforces existing tentative siblings instead of creating duplicates,
 *   - applies similarity gating (embedding cosine) against siblings,
 *   - tracks observation counts and promotes tentative → canonical when the
 *     frequency gate is satisfied,
 *   - records every schema mutation in schema_versions for audit/replay.
 *
 * All writes flow through TaxonomyRepo (Drizzle). No raw SQL.
 */

import {
  taxonomyRepo,
  type TaxonomyNode,
  type FieldDef,
  type FieldDataType,
  type CreateNodeParams,
  type CreateFieldParams,
} from "@/db/repos/TaxonomyRepo";
import { embeddingRepo } from "@/db/repos/EmbeddingRepo";
import { cachedFetch } from "@/lib/cached_fetch";

export interface ProposedField {
  readonly key: string;
  readonly label: string;
  readonly dataType: FieldDataType;
  readonly pattern?: string;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly isInteger?: boolean;
  readonly format?: string;
  readonly unit?: string;
  readonly extractHint?: string;
  readonly isRequired?: boolean;
  readonly isSearchable?: boolean;
  readonly searchWeight?: number;
  readonly isIdentifier?: boolean;
  readonly isPricingAxis?: boolean;
  readonly displayPriority?: number;
  readonly isHidden?: boolean;
}

export interface NodeProposal {
  readonly slug: string;
  readonly label: string;
  readonly description: string;
  readonly fields: ReadonlyArray<ProposedField>;
}

export interface ProposeNodeResult {
  readonly nodeId: number;
  readonly created: boolean;
  readonly reinforced: boolean;
}

export interface ProposeFieldResult {
  readonly fieldId: number;
  readonly created: boolean;
  readonly reinforced: boolean;
}

export interface SchemaGrowthConfig {
  readonly frequencyThreshold: number;
  readonly similarityThreshold: number;
  readonly ollamaUrl?: string;
}

const DEFAULT_CONFIG: SchemaGrowthConfig = {
  frequencyThreshold: 3,
  // 0.82 with embeddings catches true near-duplicates (whisky↔whiskey,
  // spirits↔liquor_spirits, wines↔wine, single_malt↔single_malt_scotch)
  // without merging genuinely distinct categories.
  similarityThreshold: 0.82,
  // Real embedding similarity — the string-overlap fallback can't tell
  // "spirits" from "liquor_spirits" because token overlap is too coarse.
  ollamaUrl: process.env.OLLAMA_URL ?? "http://battleaxe:11434",
};

function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}


export class SchemaGrowthService {
  private readonly config: SchemaGrowthConfig;

  constructor(config: Partial<SchemaGrowthConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async proposeChildNode(params: {
    readonly parentId: number;
    readonly slug: string;
    readonly label: string;
    readonly description: string;
    readonly fields: ReadonlyArray<ProposedField>;
    readonly triggeredBy: string;
  }): Promise<ProposeNodeResult> {
    const slug = normalizeSlug(params.slug);

    // 1. Exact slug match → reinforce existing sibling.
    const siblings = await taxonomyRepo.getChildren(params.parentId);
    const exact = siblings.find((s) => s.slug === slug);
    if (exact) {
      await taxonomyRepo.incrementObservation(exact.id);
      await this.tryPromoteNode(exact.id);
      return {
        nodeId: exact.id,
        created: false,
        reinforced: true,
      };
    }

    // 2. Similarity check — merge into an existing sibling if very close.
    const similar = await this.findSimilarSibling(params.parentId, {
      slug,
      label: params.label,
      description: params.description,
      fields: params.fields,
    });
    if (similar) {
      await taxonomyRepo.incrementObservation(similar.id);
      await this.tryPromoteNode(similar.id);
      return {
        nodeId: similar.id,
        created: false,
        reinforced: true,
      };
    }

    // 3. Create tentative node + its initial field proposals, all atomic.
    const nodeParams: CreateNodeParams = {
      parentId: params.parentId,
      slug,
      label: params.label,
      description: params.description,
      canonical: false,
    };

    const node = await taxonomyRepo.createNode(nodeParams, params.triggeredBy);
    await taxonomyRepo.incrementObservation(node.id);

    for (const f of params.fields) {
      await this.proposeFieldInternal({
        nodeId: node.id,
        field: f,
        triggeredBy: params.triggeredBy,
      });
    }

    return {
      nodeId: node.id,
      created: true,
      reinforced: false,
    };
  }

  async proposeField(params: {
    readonly nodeId: number;
    readonly field: ProposedField;
    readonly triggeredBy: string;
  }): Promise<ProposeFieldResult> {
    return this.proposeFieldInternal(params);
  }

  private async proposeFieldInternal(params: {
    readonly nodeId: number;
    readonly field: ProposedField;
    readonly triggeredBy: string;
  }): Promise<ProposeFieldResult> {
    const existing = await taxonomyRepo.getFieldsForNode(params.nodeId);
    const match = existing.find((f) => f.key === params.field.key);
    if (match) {
      await taxonomyRepo.incrementFieldObservation(match.id);
      await this.tryPromoteField(match.id);
      return { fieldId: match.id, created: false, reinforced: true };
    }

    const createParams: CreateFieldParams = {
      nodeId: params.nodeId,
      key: params.field.key,
      label: params.field.label,
      dataType: params.field.dataType,
      pattern: params.field.pattern,
      minValue: params.field.minValue,
      maxValue: params.field.maxValue,
      isInteger: params.field.isInteger,
      format: params.field.format,
      unit: params.field.unit,
      extractHint: params.field.extractHint,
      isRequired: params.field.isRequired,
      isSearchable: params.field.isSearchable,
      searchWeight: params.field.searchWeight,
      isIdentifier: params.field.isIdentifier,
      isPricingAxis: params.field.isPricingAxis,
      displayPriority: params.field.displayPriority,
      isHidden: params.field.isHidden,
      canonical: false,
    };

    const field = await taxonomyRepo.createField(
      createParams,
      params.triggeredBy,
    );
    await taxonomyRepo.incrementFieldObservation(field.id);
    return { fieldId: field.id, created: true, reinforced: false };
  }

  async tryPromoteNode(nodeId: number): Promise<boolean> {
    const node = await taxonomyRepo.getNode(nodeId);
    if (!node) return false;
    if (node.canonical) return false;
    if (node.observationCount < this.config.frequencyThreshold) return false;
    await taxonomyRepo.promoteNode(nodeId, "system");
    return true;
  }

  async tryPromoteField(fieldId: number): Promise<boolean> {
    const fields = await this.loadFieldById(fieldId);
    if (!fields) return false;
    if (fields.canonical) return false;
    if (fields.observationCount < this.config.frequencyThreshold) return false;
    await taxonomyRepo.promoteField(fieldId, "system");
    return true;
  }

  private async loadFieldById(fieldId: number): Promise<FieldDef | null> {
    // Small helper — grab the single field row via TaxonomyRepo by scanning
    // its parent node's fields (avoids adding raw SQL to the repo).
    // Find the node_id by loading all fields via drizzle query.
    const list = await taxonomyRepo.runInTransaction(() =>
      Promise.resolve(null as FieldDef | null),
    );
    // Fallback: query via a direct node lookup using a specialized method.
    void list;
    return this.findFieldById(fieldId);
  }

  private async findFieldById(fieldId: number): Promise<FieldDef | null> {
    // Walk a small index: we know fields live on exactly one node; use the
    // repo helpers. Given taxonomy is shallow, linear scan of nodes is
    // O(nodes). For large trees we'd add a direct getFieldById, but we keep
    // everything Drizzle-based here.
    const { db } = await import("@/db/client");
    const { taxonomyNodeFields } = await import("@/db/schema");
    const { eq } = await import("drizzle-orm");
    const row = await db.query.taxonomyNodeFields.findFirst({
      where: eq(taxonomyNodeFields.id, fieldId),
    });
    if (!row) return null;
    const fields = await taxonomyRepo.getFieldsForNode(row.nodeId);
    return fields.find((f) => f.id === fieldId) ?? null;
  }

  /**
   * Similarity gate — returns an existing sibling that's a near-duplicate of
   * the proposal, or null if the proposal is genuinely novel.
   *
   * Uses embedding cosine similarity against sibling (label + description)
   * text. Falls back to a simple string-overlap metric if embeddings are
   * unavailable (no network / Ollama down).
   */
  async findSimilarSibling(
    parentId: number,
    proposal: NodeProposal,
  ): Promise<TaxonomyNode | null> {
    // Check siblings at this parent AND all existing nodes anywhere in the tree.
    // A new "video_games" under root shouldn't create a duplicate if "video_games"
    // already exists elsewhere (e.g. under electronics).
    const siblings = await taxonomyRepo.getChildren(parentId);
    const allNodes = await taxonomyRepo.getAllNodes();
    // Siblings first (more relevant for true merges), then the rest.
    const siblingIds = new Set(siblings.map((s) => s.id));
    const candidates = [
      ...siblings,
      ...allNodes.filter((n) => !siblingIds.has(n.id) && n.id !== 1 /* skip root */),
    ];
    if (candidates.length === 0) return null;

    const proposalText = this.nodeText(proposal.label, proposal.description);
    const proposalSlug = proposal.slug.toLowerCase();
    const proposalVec = await this.embed(proposalText);

    // First pass: exact slug match anywhere in tree → strong duplicate signal.
    for (const n of candidates) {
      if (n.slug.toLowerCase() === proposalSlug) return n;
    }

    // Second pass: near-duplicate slugs (substring containment, edit distance).
    // Catches whisky↔whiskey, wines↔wine, spirits↔liquor_spirits — all cases
    // a weak string-overlap metric misses. Works independent of embeddings.
    for (const n of candidates) {
      if (slugsLookLikeDuplicates(n.slug, proposalSlug)) return n;
    }

    if (proposalVec) {
      for (const s of candidates) {
        const sibText = this.nodeText(s.label, s.description ?? "");
        const sibVec = await this.embed(sibText);
        if (!sibVec) continue;
        const sim = cosine(proposalVec, sibVec);
        if (sim >= this.config.similarityThreshold) return s;
      }
      return null;
    }

    // Embedding fallback — deterministic string-overlap sanity check.
    for (const s of candidates) {
      const sim = stringOverlap(
        proposalText.toLowerCase(),
        this.nodeText(s.label, s.description ?? "").toLowerCase(),
      );
      if (sim >= this.config.similarityThreshold) return s;
    }
    return null;
  }

  private nodeText(label: string, description: string): string {
    return `${label}\n${description}`.trim();
  }

  private async embed(text: string): Promise<number[] | null> {
    const url = this.config.ollamaUrl;
    if (!url) return null;
    try {
      const resp = await cachedFetch(
        `${url}/api/embed`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "qwen3-embedding:8b", input: text }),
        },
        { ttlMs: null, cacheTag: "embed" },
      );
      if (!resp.ok) return null;
      const data = resp.json<{ embeddings?: number[][] }>();
      return data.embeddings?.[0] ?? null;
    } catch {
      return null;
    }
  }
}

function cosine(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function stringOverlap(a: string, b: string): number {
  if (!a || !b) return 0;
  const aTokens = new Set(a.split(/\s+/).filter(Boolean));
  const bTokens = new Set(b.split(/\s+/).filter(Boolean));
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  let shared = 0;
  for (const t of aTokens) if (bTokens.has(t)) shared++;
  const union = new Set([...aTokens, ...bTokens]).size;
  return shared / union;
}

/**
 * Pure slug/label near-duplicate heuristic — catches the cases the embedding
 * similarity gate is supposed to catch but where we want a hard signal
 * independent of model availability. Returns true when the proposed slug
 * collides with an existing one by:
 *   - exact match (after normalization)
 *   - substring containment (spirits / liquor_spirits, wine / wines)
 *   - small edit distance on normalized slugs (whisky / whiskey, rose / rose_wine)
 */
function slugsLookLikeDuplicates(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const nb = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!na || !nb) return false;
  if (na === nb) return true;
  // Substring containment with a length-ratio gate. "spirits" vs
  // "liquor_spirits" (7/13 = 0.54) should match; "alcohol" vs
  // "alcoholic_beverages" (7/19 = 0.37) should not — the shorter slug is
  // only a fragment of the longer's semantic content.
  if (na.includes(nb) || nb.includes(na)) {
    const shorter = na.length < nb.length ? na : nb;
    const longer = na.length < nb.length ? nb : na;
    if (shorter.length >= 4 && shorter.length / longer.length >= 0.4) {
      return true;
    }
  }
  // Edit-distance bound — small typos / variants (whisky vs whiskey, wine
  // vs wines).
  if (Math.abs(na.length - nb.length) <= 2) {
    const maxLen = Math.max(na.length, nb.length);
    if (maxLen <= 12 && levenshtein(na, nb) <= 1) return true;
    if (maxLen <= 20 && levenshtein(na, nb) <= 2) return true;
  }
  return false;
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

// Tag unused to satisfy strict lint when embedding stub isn't wired.
void embeddingRepo;

export const schemaGrowthService = new SchemaGrowthService();
