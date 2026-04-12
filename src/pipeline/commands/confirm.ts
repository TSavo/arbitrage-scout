import type { ExtractedItem, CatalogMatch } from '../types';
import type { ProductTypeSchema } from '@/db/repos/ProductTypeRepo';

export interface ConfirmInput {
  readonly items: readonly ExtractedItem[];
  readonly candidates: ReadonlyMap<number, readonly CatalogMatch[]>;
  readonly listingPrice: number;
  readonly marketplaceId?: string;
  readonly useLlm?: boolean;
  readonly llmClient?: LlmClient;
}

export interface ConfirmOutput {
  readonly matches: ReadonlyMap<number, CatalogMatch | null>;
  readonly confirmedCount: number;
  readonly rejectedCount: number;
  readonly confirmedAt: number;
}

export interface LlmClient {
  generateJson(prompt: string, opts?: { system?: string }): Promise<unknown>;
}

export interface LlmConfirmOptions {
  readonly productTypes?: readonly ProductTypeSchema[];
}

const AUTO_CONFIRM_THRESHOLD = 0.7;

const CONFIRM_SYSTEM = `You are the quality gate in a collectibles arbitrage system. We buy underpriced items on one marketplace and resell at market value on another. A false positive here means we buy something worthless thinking it's valuable — that costs real money. A false negative means we miss a deal — that's fine, there will be more. When in doubt, reject. Only confirm matches you're confident about.

CRITICAL for trading cards: every unique card has a specific set name and card number. Do NOT match a specific card to a generic product (e.g. 'Pokemon Zany Cards', 'Pokemon Card Game'). Do NOT match cards from different sets even if they feature the same character. If the set or number doesn't match, reject.

CRITICAL: if the listing says 'custom', 'custom card', 'fan made', 'proxy', 'replica', 'reprint', 'gold custom', or 'gold plated' — REJECT. These are worthless fakes. A 'Pokemon Gold Custom Pikachu Card' is NOT a real Pikachu card. Never match custom/fan-made items to real catalog products.

Reply with JSON only.`;

export async function confirm(input: ConfirmInput, options?: LlmConfirmOptions): Promise<ConfirmOutput> {
  const start = Date.now();
  const { items, candidates } = input;

  const matches = new Map<number, CatalogMatch | null>();
  let confirmedCount = 0;
  let rejectedCount = 0;

  if (input.useLlm && input.llmClient) {
    const result = await llmConfirm(items, candidates, input.llmClient, {
      listingPrice: input.listingPrice,
      marketplaceId: input.marketplaceId ?? '',
      productTypes: options?.productTypes,
    });
    return {
      matches: result.matches as ReadonlyMap<number, CatalogMatch | null>,
      confirmedCount: result.confirmedCount,
      rejectedCount: result.rejectedCount,
      confirmedAt: start,
    };
  }

  for (let idx = 0; idx < items.length; idx++) {
    const cands = candidates.get(idx) ?? [];
    const item = items[idx];

    if (cands.length > 0 && cands[0].score >= AUTO_CONFIRM_THRESHOLD) {
      matches.set(idx, cands[0]);
      confirmedCount++;
    } else {
      matches.set(idx, null);
      rejectedCount++;
    }
  }

  return Object.freeze({
    matches: matches as ReadonlyMap<number, CatalogMatch | null>,
    confirmedCount,
    rejectedCount,
    confirmedAt: start,
  });
}

async function llmConfirm(
  items: readonly ExtractedItem[],
  candidates: ReadonlyMap<number, readonly CatalogMatch[]>,
  llm: LlmClient,
  opts: { listingPrice: number; marketplaceId: string; productTypes?: readonly ProductTypeSchema[] }
): Promise<{ matches: Map<number, CatalogMatch | null>; confirmedCount: number; rejectedCount: number }> {
  const matches = new Map<number, CatalogMatch | null>();
  let confirmedCount = 0;
  let rejectedCount = 0;

  const lines: string[] = [];

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const cands = candidates.get(idx) ?? [];

    const metaParts = Object.entries(item.metadata || {})
      .filter(([, v]) => v)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}=${v}`);
    const metaStr = metaParts.length ? ` | ${metaParts.join(', ')}` : '';

    lines.push(
      `Item ${idx + 1}: "${item.name}" ` +
      `(type: ${item.productType}, platform: ${item.platform ?? '(none)'}, ` +
      `condition: ${item.condition ?? 'unknown'}${metaStr})`
    );

    if (cands.length === 0) {
      lines.push('  No catalog matches found → null');
      continue;
    }

    for (let j = 0; j < cands.length; j++) {
      const c = cands[j];
      const matchPct = `${(c.score * 100).toFixed(0)}%`;
      lines.push(
        `  ${String.fromCharCode(65 + j)}) ${c.title} (${c.platform ?? 'N/A'}) ` +
        `— score=${matchPct}`
      );
    }
    lines.push(`  ${String.fromCharCode(65 + cands.length)}) None of these`);
  }

  const conditionHints = buildConditionHints(items, opts.productTypes);
  for (const hint of conditionHints) {
    lines.push(hint);
  }

  const perItemLine = items.length > 1
    ? `Per-item cost: $${(opts.listingPrice / items.length).toFixed(2)}\n`
    : '';

  const prompt =
    '## Context\n\n' +
    'You are the final gate in our arbitrage identification pipeline.\n' +
    'Stage 1 extracted product data from a marketplace listing.\n' +
    'Stage 2 found candidate matches in our 300K product catalog.\n' +
    'Your job: confirm or reject each match.\n\n' +
    `Listing price: $${opts.listingPrice.toFixed(2)} on ${opts.marketplaceId}\n` +
    `Item count: ${items.length} items extracted\n` +
    perItemLine +
    '\n' +
    '## Extracted items and catalog candidates\n\n' +
    lines.join('\n') + '\n\n' +
    '## Instructions\n\n' +
    '- Pick the catalog product that BEST matches the extracted item\n' +
    '- Reject (null) if no candidate is the right product\n' +
    '- Reject if the listing is a reproduction, fake, or unrelated item\n' +
    '- TRADING CARDS (Pokemon, MTG, Yu-Gi-Oh, etc.): A match is ONLY valid if the SET NAME and CARD NUMBER match or are very close. ' +
    "'Charizard VMAX 020/189 Darkness Ablaze' does NOT match 'Charizard GX 009/068 Hidden Fates' — these are completely different products worth different amounts. " +
    "If the catalog candidate is a generic product like 'Pokemon Zany Cards' or a compilation/accessory and the extracted item is a specific card, REJECT the match. Different set = different product.\n" +
    '- Confirm the condition based on the listing context\n' +
    '- Use the valid conditions listed per item above\n\n' +
    '## Response\n\n' +
    '{"matches": [{"item": 1, "choice": "A", "condition": "condition_value"}, ...]}\n' +
    'Use null for choice if no match.';

  try {
    const result = await llm.generateJson(prompt, { system: CONFIRM_SYSTEM });

    const data = result as { matches?: Array<{ item?: number; choice?: string | null; condition?: string }> };
    const matchData = data?.matches ?? [];

    for (const m of matchData) {
      const idx = (m.item ?? 1) - 1;
      if (idx < 0 || idx >= items.length) continue;

      const cands = [...(candidates.get(idx) ?? [])];

      if (m.choice === null || m.choice === undefined) {
        matches.set(idx, null);
        rejectedCount++;
        continue;
      }

      const choiceUpper = String(m.choice).toUpperCase();
      const lastOption = String.fromCharCode(65 + cands.length);

      if (choiceUpper === lastOption) {
        matches.set(idx, null);
        rejectedCount++;
        continue;
      }

      const candIdx = choiceUpper.charCodeAt(0) - 65;
      if (candIdx >= 0 && candIdx < cands.length) {
        const base = cands[candIdx];
        const selected: CatalogMatch = m.condition
          ? { ...base, condition: m.condition }
          : base;
        matches.set(idx, selected);
        confirmedCount++;
      } else {
        matches.set(idx, null);
        rejectedCount++;
      }
    }
  } catch {
    for (let idx = 0; idx < items.length; idx++) {
      if (!matches.has(idx)) {
        const cands = [...(candidates.get(idx) ?? [])];
        if (cands.length > 0 && cands[0].score >= AUTO_CONFIRM_THRESHOLD) {
          matches.set(idx, cands[0]);
          confirmedCount++;
        } else {
          matches.set(idx, null);
          rejectedCount++;
        }
      }
    }
  }

  return { matches, confirmedCount, rejectedCount };
}

function buildConditionHints(
  items: readonly ExtractedItem[],
  productTypes?: readonly ProductTypeSchema[],
): string[] {
  const hints: string[] = [];
  const ptCache = new Map<string, string>();

  for (let idx = 0; idx < items.length; idx++) {
    const ptId = items[idx].productType;
    if (!ptCache.has(ptId) && productTypes) {
      const pt = productTypes.find((p) => p.id === ptId);
      const axisDesc: string[] = [];
      if (pt) {
        for (const f of pt.fields) {
          if (!f.isPricingAxis) continue;
          const values = f.enumValues?.map((e) => e.value).join(', ');
          axisDesc.push(values ? `${f.key} (${values})` : f.key);
        }
      }
      ptCache.set(ptId, axisDesc.length ? axisDesc.join(' | ') : '(none — single price)');
    }
    hints.push(`  Pricing axes for item ${idx + 1}: ${ptCache.get(ptId) ?? '(none — single price)'}`);
  }

  return hints;
}
