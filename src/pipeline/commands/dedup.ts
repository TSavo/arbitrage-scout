import type { ExtractedItem, CatalogMatch } from '../types';

export interface DeduplicationResult {
  readonly conflictsFound: number;
  readonly resolvedCount: number;
  readonly details: ReadonlyArray<{
    itemIndex: number;
    note: string;
  }>;
}

export interface DedupInput {
  readonly items: readonly ExtractedItem[];
  readonly candidates: ReadonlyMap<number, readonly CatalogMatch[]>;
}

export interface DedupOutput {
  readonly candidates: ReadonlyMap<number, readonly CatalogMatch[]>;
  readonly dedup: DeduplicationResult;
}

export type DedupCommand = {
  readonly id: string;
  readonly type: 'dedup';
  readonly input: DedupInput;
  readonly output: DedupOutput;
  readonly timestamp: number;
  readonly durationMs: number;
};

export function deduplicate(input: DedupInput): DedupOutput {
  const { items, candidates } = input;

  if (items.length <= 1) {
    return {
      candidates,
      dedup: Object.freeze({
        conflictsFound: 0,
        resolvedCount: 0,
        details: [],
      }),
    };
  }

  const details: Array<{ itemIndex: number; note: string }> = [];

  const topProductCounts = new Map<string, {
    bestScore: number;
    bestIdx: number;
    count: number;
  }>();

  for (let idx = 0; idx < items.length; idx++) {
    const cands = candidates.get(idx);
    if (!cands || cands.length === 0) continue;

    const topId = cands[0].productId;
    const topScore = cands[0].score;

    const existing = topProductCounts.get(topId);
    if (!existing) {
      topProductCounts.set(topId, { bestScore: topScore, bestIdx: idx, count: 1 });
    } else {
      existing.count++;
      if (topScore > existing.bestScore) {
        existing.bestScore = topScore;
        existing.bestIdx = idx;
      }
    }
  }

  const duplicateProductIds = new Set<string>();
  for (const [productId, info] of topProductCounts) {
    if (info.count > 1) {
      duplicateProductIds.add(productId);
    }
  }

  const newCandidates = new Map<number, CatalogMatch[]>();

  for (let idx = 0; idx < items.length; idx++) {
    const cands = [...(candidates.get(idx) ?? [])];
    newCandidates.set(idx, cands);

    if (cands.length === 0) continue;

    const topId = cands[0].productId;
    const info = topProductCounts.get(topId);

    if (!info) continue;

    if (info.count > 1 && duplicateProductIds.has(topId)) {
      if (info.bestIdx === idx) {
        details.push({
          itemIndex: idx,
          note: 'winner (highest score among duplicates)',
        });
      } else {
        const filtered = cands.filter(c => c.productId !== topId);
        newCandidates.set(idx, filtered);

        if (filtered.length === 0) {
          details.push({
            itemIndex: idx,
            note: `removed (duplicate of item ${info.bestIdx + 1})`,
          });
        } else {
          details.push({
            itemIndex: idx,
            note: `demoted (had duplicate #1 with item ${info.bestIdx + 1})`,
          });
        }
      }
    }
  }

  return Object.freeze({
    candidates: newCandidates as ReadonlyMap<number, readonly CatalogMatch[]>,
    dedup: Object.freeze({
      conflictsFound: details.filter(d => d.note.includes('removed')).length,
      resolvedCount: details.length,
      details: Object.freeze(details),
    }),
  });
}
