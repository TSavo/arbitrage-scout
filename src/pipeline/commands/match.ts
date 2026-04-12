import type { ExtractedItem, CatalogMatch } from '../types';
import { db } from '@/db/client';
import { products, pricePoints } from '@/db/schema';
import { eq, desc, and, gt, sql } from 'drizzle-orm';
import { embeddingRepo } from '@/db/repos/EmbeddingRepo';
import { productTypeRepo, type ProductTypeSchema } from '@/db/repos/ProductTypeRepo';

export interface MatchInput {
  readonly items: readonly ExtractedItem[];
  readonly useFts5?: boolean;
  readonly useEmbedding?: boolean;
  readonly useDifflib?: boolean;
  readonly ollamaUrl?: string;
  /** Optional schema set; falls back to repo lookup if omitted. */
  readonly schema?: readonly ProductTypeSchema[];
}

export interface MatchOutput {
  readonly candidates: ReadonlyMap<number, readonly CatalogMatch[]>;
  readonly matchCounts: readonly number[];
  readonly totalCandidates: number;
  readonly matchedAt: number;
}

export type MatchCommand = {
  readonly id: string;
  readonly type: 'match';
  readonly input: MatchInput;
  readonly output: MatchOutput;
  readonly timestamp: number;
  readonly durationMs: number;
};

export interface MatchingStrategy {
  name: string;
  priority: number;
  minConfidence: number;
  match(item: ExtractedItem): Promise<CatalogMatch | null>;
}

export class FTS5Strategy implements MatchingStrategy {
  name = 'fts5' as const;
  priority = 1;
  minConfidence = 0.70;

  constructor(private schemas?: readonly ProductTypeSchema[]) {}

  async match(item: ExtractedItem): Promise<CatalogMatch | null> {
    const searchTerms = this.buildSearchTerms(item);
    const cleanQuery = searchTerms.replace(/"/g, '""');

    try {
      const rows = await db.all<{
        product_id: string;
        title: string;
        product_type_id: string;
        platform: string | null;
        rank: number;
      }>(sql`
        SELECT 
          pf.product_id,
          pf.title,
          pf.product_type_id,
          pf.platform,
          pf.rank
        FROM products_fts pf
        WHERE pf.product_type_id = ${item.productType}
          AND products_fts MATCH ${cleanQuery}
        ORDER BY pf.rank
        LIMIT 5
      `);

      if (rows.length === 0) return null;

      const top = rows[0];
      const ftsScore = Math.min(1.0, Math.max(0.3, 1.0 + top.rank / 10));

      let score = ftsScore;
      if (item.platform && top.platform) {
        const searchPlat = item.platform.toLowerCase();
        const resultPlat = top.platform.toLowerCase();
        if (searchPlat.includes(resultPlat) || resultPlat.includes(searchPlat)) {
          score = Math.min(1.0, score + 0.15);
        }
      }

      return {
        productId: top.product_id,
        title: top.title,
        score,
        method: 'fts5',
        productTypeId: top.product_type_id,
        platform: top.platform ?? undefined,
      };
    } catch {
      return null;
    }
  }

  private buildSearchTerms(item: ExtractedItem): string {
    const schema = this.schemas?.find((s) => s.id === item.productType);
    const searchableFields = schema?.fields.filter((f) => f.isSearchable) ?? [];

    // Name is always the primary search term.
    const parts: Array<{ text: string; weight: number }> = [{ text: item.name, weight: 3 }];

    if (schema) {
      // Data-driven: only include field values flagged as searchable, weighted
      // by the field's search_weight.
      for (const f of searchableFields) {
        const val = item.metadata?.[f.key];
        if (val !== undefined && val !== null && val !== '') {
          parts.push({ text: String(val), weight: f.searchWeight });
        }
      }
    } else {
      // Schema-less fallback: keep legacy behavior so matches don't vanish.
      if (item.platform) parts.push({ text: item.platform, weight: 2 });
      for (const [key, value] of Object.entries(item.metadata ?? {})) {
        if (value && (key === 'set_name' || key === 'card_number')) {
          parts.push({ text: String(value), weight: 3 });
        }
      }
    }

    return parts
      .filter((p) => p.text && p.text.length > 0)
      .map((p) => `"${p.text.replace(/"/g, '')}"^${Math.max(1, Math.round(p.weight))}`)
      .join(' ');
  }
}

export class EmbeddingStrategy implements MatchingStrategy {
  name = 'embedding' as const;
  priority = 2;
  minConfidence = 0.60;

  private ollamaUrl: string;

  constructor(ollamaUrl = 'http://battleaxe:11434', private schemas?: readonly ProductTypeSchema[]) {
    this.ollamaUrl = ollamaUrl;
  }

  async match(item: ExtractedItem): Promise<CatalogMatch | null> {
    try {
      const schema = this.schemas?.find((s) => s.id === item.productType);
      const parts: string[] = [item.name];
      if (schema) {
        for (const f of schema.fields) {
          if (!f.isSearchable) continue;
          const val = item.metadata?.[f.key];
          if (val === undefined || val === null || val === '') continue;
          // Weight by repetition — embedding models amplify repeated tokens.
          const copies = Math.max(1, Math.round(f.searchWeight));
          for (let i = 0; i < copies; i++) parts.push(String(val));
        }
      } else if (item.platform) {
        parts.push(item.platform);
      }
      const searchText = parts.filter(Boolean).join(' ');

      const resp = await fetch(`${this.ollamaUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: 'qwen3-embedding:8b', input: searchText }),
      });

      if (!resp.ok) return null;

      const data = (await resp.json()) as { embeddings?: number[][] };
      const queryVec = data.embeddings?.[0];
      if (!queryVec?.length) return null;

      const similar = await embeddingRepo.findSimilar('product', queryVec, 5);
      if (!similar.length) return null;

      const top = similar[0];
      const product = await db.query.products.findFirst({
        where: eq(products.id, top.entityId),
        columns: {
          id: true,
          title: true,
          platform: true,
          productTypeId: true,
        },
      });

      if (!product) return null;

      const score = Math.max(0, 1.0 - top.distance / 2);

      return {
        productId: product.id,
        title: product.title,
        score,
        method: 'embedding',
        productTypeId: product.productTypeId,
        platform: product.platform ?? undefined,
      };
    } catch {
      return null;
    }
  }
}

export class DifflibStrategy implements MatchingStrategy {
  name = 'difflib' as const;
  priority = 3;
  minConfidence = 0.40;

  async match(item: ExtractedItem): Promise<CatalogMatch | null> {
    const searchTerm = item.name.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').trim();
    if (searchTerm.length < 3) return null;

    try {
      const catalog = await db
        .select({
          id: products.id,
          title: products.title,
          productTypeId: products.productTypeId,
          platform: products.platform,
          priceUsd: pricePoints.priceUsd,
          salesVolume: products.salesVolume,
        })
        .from(products)
        .innerJoin(pricePoints, eq(pricePoints.productId, products.id))
        .where(and(eq(pricePoints.condition, 'loose'), gt(pricePoints.priceUsd, 2)))
        .orderBy(desc(products.salesVolume))
        .limit(5000)
        .all();

      let bestMatch: { id: string; title: string; score: number } | null = null;
      let bestScore = 0;

      for (const candidate of catalog) {
        if (candidate.productTypeId !== item.productType) continue;

        const score = this.sequenceRatio(
          searchTerm,
          `${candidate.title} ${candidate.platform ?? ''}`.toLowerCase()
        );

        if (score > bestScore) {
          bestScore = score;
          bestMatch = { id: candidate.id, title: candidate.title, score };
        }
      }

      if (!bestMatch || bestScore < this.minConfidence) return null;

      return {
        productId: bestMatch.id,
        title: bestMatch.title,
        score: bestScore,
        method: 'difflib',
        productTypeId: item.productType,
      };
    } catch {
      return null;
    }
  }

  private sequenceRatio(a: string, b: string): number {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const shorter = a.length < b.length ? a : b;
    const longer = a.length < b.length ? b : a;
    if (longer.length === 0) return 1;

    let matches = 0;
    const used = new Array<boolean>(longer.length).fill(false);

    for (const ch of shorter) {
      for (let j = 0; j < longer.length; j++) {
        if (longer[j] === ch && !used[j]) {
          matches++;
          used[j] = true;
          break;
        }
      }
    }

    return (2 * matches) / (shorter.length + longer.length);
  }
}

export async function match(input: MatchInput): Promise<MatchOutput> {
  const start = Date.now();
  const strategies: MatchingStrategy[] = [];

  const schemas = input.schema ?? (await productTypeRepo.getAllSchemas());

  if (input.useFts5 !== false) {
    strategies.push(new FTS5Strategy(schemas));
  }

  if (input.useEmbedding !== false) {
    strategies.push(new EmbeddingStrategy(input.ollamaUrl, schemas));
  }

  if (input.useDifflib !== false) {
    strategies.push(new DifflibStrategy());
  }

  strategies.sort((a, b) => a.priority - b.priority);

  const candidates = new Map<number, CatalogMatch[]>();
  const matchCounts: number[] = [];
  let totalCandidates = 0;

  for (const item of input.items) {
    let bestMatch: CatalogMatch | null = null;

    for (const strategy of strategies) {
      const match = await strategy.match(item);
      if (match && match.score >= strategy.minConfidence) {
        bestMatch = match;
        break;
      }
    }

    const itemMatches = bestMatch ? [bestMatch] : [];
    candidates.set(matchCounts.length, itemMatches);
    matchCounts.push(itemMatches.length);
    if (bestMatch) totalCandidates++;
  }

  return Object.freeze({
    candidates: candidates as ReadonlyMap<number, readonly CatalogMatch[]>,
    matchCounts: Object.freeze([...matchCounts]),
    totalCandidates,
    matchedAt: start,
  });
}
