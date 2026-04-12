import type { ExtractedItem, MetadataValue } from '../types';
import { generateId } from '../utils';
import { OllamaClient } from '@/llm/ollama';
import { productTypeRepo, type ProductTypeSchema, type FieldDef } from '@/db/repos/ProductTypeRepo';

// Re-export so callers don't have to know about the repo module.
export type { ProductTypeSchema, FieldDef } from '@/db/repos/ProductTypeRepo';

export interface ExtractInput {
  readonly listing: {
    readonly title: string;
    readonly description?: string;
    readonly conditionRaw?: string;
    readonly categoryRaw?: string;
    readonly priceUsd: number;
    readonly shippingUsd?: number;
    readonly itemCount?: number;
    readonly numBids?: number;
    readonly endTime?: string;
    readonly seller?: string;
    readonly imageUrl?: string;
    readonly extra?: Record<string, unknown>;
    readonly marketplaceId: string;
  };
  readonly schema: readonly ProductTypeSchema[];
}

export interface ExtractOutput {
  readonly items: readonly ExtractedItem[];
  readonly confidence: number;
  readonly extractedAt: number;
  readonly usedLlm: boolean;
}

const EXTRACTION_SYSTEM = `You are a product identification specialist for a collectibles arbitrage system. Your job is to turn unstructured marketplace listings into structured product data that can be matched against a price catalog of 300,000+ items.

Precision matters: the downstream system uses fuzzy matching, so the closer your extraction is to the canonical name (e.g. 'Super Mario 64' not 'SM64 N64 Cart'), the better the match.

Completeness matters: every metadata field you fill in helps the system pick the right price point (a graded PSA 10 Charizard is worth 100x a loose played copy).

CRITICAL for trading cards: ALWAYS include the SET NAME and CARD NUMBER in the name field (e.g. 'Charizard VMAX 020/189 Darkness Ablaze'). Without these, the system cannot distinguish between the hundreds of different Charizard cards in the catalog. Each card in a lot is a DISTINCT product — never use the same name for multiple cards.

Reply with JSON only.`;

const EXTRACTION_PROMPT = `## Marketplace listing

{context}

## Your task

We are building an arbitrage tool that finds underpriced collectibles across marketplaces (eBay, ShopGoodWill, PriceCharting). We need to identify exactly what products are in this listing so we can look up their market value in our catalog of 300,000+ products.

If this is a LOT containing multiple items, extract EACH named item separately. The system will price each one individually and compare the total value against the lot price. This is how we find underpriced lots — a $50 lot containing $200 worth of games is a deal.

## Product types we track

{schema}

## Rules

- Identify EVERY individual product in the listing
- Use the FULL canonical product name (expand SM64 → Super Mario 64, CIB → Complete in Box, NM → Near Mint)
- Pick the correct product_type from the list above
- Fill in the metadata fields defined for that product type — each field shows its data_type, constraints, and (if any) valid enum values
- If the listing is NOT a product we track (furniture, clothing, Wi-Fi equipment, plush toys, board games), return empty items
- If it's a random/mystery lot with no named items, return empty
- If the title contains 'custom', 'custom card', 'fan made', 'proxy', 'replica', 'reprint', 'fake', 'gold plated', or 'gold custom' — this is NOT an authentic product. Return empty items.
- If the title mentions 'untested', 'for parts', 'as-is', note that in the metadata — it affects value significantly
- TRADING CARDS: The SET NAME and CARD NUMBER are the PRIMARY identifiers. Always fill in those metadata fields AND include them in the 'name' field.

## Response format

{"items": [{"name": "canonical product name", "product_type": "type_id", "metadata": {fill in all metadata fields for this type by key}, "quantity": 1}]}`;

const REJECT_KEYWORDS = ['custom', 'custom card', 'fan made', 'proxy', 'replica', 'reprint', 'fake', 'gold plated', 'gold custom'];

const NON_TRACKABLE = ['furniture', 'clothing', 'board game', 'plush toy', 'sticker', 'poster', 'book'];

// Fallback keyword hints for rule-based extraction. Only used when the schema
// itself doesn't provide extract hints — the authoritative source is the DB.
const FALLBACK_TYPE_KEYWORDS: Record<string, readonly string[]> = {
  retro_game: ['nintendo', 'sega', 'playstation', 'gameboy', 'nes', 'snes', 'genesis', 'game cube', 'gamecube', 'atari'],
  pokemon_card: ['pokemon'],
  mtg_card: ['magic', 'mtg'],
  yugioh_card: ['yugioh', 'yu-gi-oh'],
  onepiece_card: ['one piece'],
  funko_pop: ['funko', 'pop!'],
  lego_set: ['lego'],
  comic: ['comic', 'marvel', 'dc'],
  coin: ['coin', 'mint', 'numismatic'],
  sports_card: ['topps', 'panini', 'bowman'],
  bourbon: ['bourbon', 'whiskey', 'whisky'],
};

function pricingAxisFields(schema: ProductTypeSchema): readonly FieldDef[] {
  return schema.fields.filter((f) => f.isPricingAxis);
}

function conditionField(schema: ProductTypeSchema): FieldDef | undefined {
  return schema.fields.find((f) => f.key === 'condition' && f.isPricingAxis);
}

function enumValuesFor(field: FieldDef | undefined): readonly string[] {
  if (!field?.enumValues) return [];
  return field.enumValues.map((e) => e.value);
}

function typeKeywords(schema: ProductTypeSchema): readonly string[] {
  const nameTokens = schema.name.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
  const fallback = FALLBACK_TYPE_KEYWORDS[schema.id] ?? [];
  return [...new Set([...fallback, ...nameTokens])];
}

export function ruleBasedExtract(input: ExtractInput): ExtractOutput {
  const { listing, schema } = input;
  const title = listing.title.toLowerCase();
  const items: ExtractedItem[] = [];

  for (const kw of NON_TRACKABLE) {
    if (title.includes(kw)) {
      return { items: Object.freeze([]), confidence: 0, extractedAt: Date.now(), usedLlm: false };
    }
  }

  for (const kw of REJECT_KEYWORDS) {
    if (title.includes(kw)) {
      return { items: Object.freeze([]), confidence: 0, extractedAt: Date.now(), usedLlm: false };
    }
  }

  for (const pt of schema) {
    const keywords = typeKeywords(pt);
    if (!keywords.some((k) => title.includes(k))) continue;

    const metadata: Record<string, MetadataValue> = {};
    if (listing.conditionRaw?.toLowerCase().includes('untested') || title.includes('untested')) {
      metadata.notes = 'untested';
    }
    if (listing.conditionRaw?.toLowerCase().includes('as-is') || title.includes('as-is')) {
      metadata.conditionNote = 'sold as-is';
    }

    const platformValue = extractPlatform(title, pt.id);
    if (platformValue) metadata.platform = platformValue;

    const conditionEnum = enumValuesFor(conditionField(pt));
    const condition = extractCondition(listing.conditionRaw ?? '', conditionEnum);
    if (condition) metadata.condition = condition;

    items.push(Object.freeze({
      id: generateId('item'),
      name: listing.title,
      productType: pt.id,
      condition,
      platform: platformValue,
      quantity: listing.itemCount ?? 1,
      confidence: 0.5,
      metadata: Object.freeze(metadata),
    }));
    break;
  }

  return {
    items: Object.freeze(items),
    confidence: items.length > 0 ? 0.5 : 0,
    extractedAt: Date.now(),
    usedLlm: false,
  };
}

export async function llmExtract(
  input: ExtractInput,
  ollamaUrl: string,
  model: string = 'qwen3:8b'
): Promise<ExtractOutput> {
  const llm = new OllamaClient({ baseUrl: ollamaUrl, model, think: false, temperature: 0 });

  const context = buildListingContext(input.listing);
  const schemaText = buildSchemaPrompt(input.schema);

  const prompt = EXTRACTION_PROMPT
    .replace('{context}', context)
    .replace('{schema}', schemaText);

  try {
    const result = await llm.generateJson(prompt, { system: EXTRACTION_SYSTEM });

    if (!result || typeof result !== 'object') {
      return ruleBasedExtract(input);
    }

    const data = result as { items?: Array<Record<string, unknown>> };
    if (!Array.isArray(data.items)) {
      return ruleBasedExtract(input);
    }

    const items: ExtractedItem[] = [];

    outer: for (const item of data.items) {
      if (!item || typeof item !== 'object') continue;
      if (typeof item.name !== 'string' || item.name.length < 2) continue;

      const lowerName = (item.name as string).toLowerCase();
      for (const kw of NON_TRACKABLE) {
        if (lowerName.includes(kw)) continue outer;
      }
      for (const kw of REJECT_KEYWORDS) {
        if (lowerName.includes(kw)) continue outer;
      }

      const productType = (item.product_type as string) ?? '';
      const typeSchema = input.schema.find((s) => s.id === productType);
      const metadata = coerceMetadata(
        (item.metadata as Record<string, unknown> | undefined) ?? {},
        typeSchema,
      );

      // Legacy top-level fields (pre-refactor prompt): fold into metadata.
      if (typeof item.condition === 'string' && !('condition' in metadata)) {
        metadata.condition = item.condition;
      }
      if (typeof item.platform === 'string' && !('platform' in metadata)) {
        metadata.platform = item.platform;
      }

      const platform = typeof metadata.platform === 'string' ? metadata.platform : undefined;
      const condition = typeof metadata.condition === 'string' ? metadata.condition : undefined;

      items.push(Object.freeze({
        id: generateId('item'),
        name: item.name as string,
        productType,
        condition,
        platform,
        quantity: typeof item.quantity === 'number' ? item.quantity : 1,
        confidence: typeof item.confidence === 'number' ? item.confidence : 0.7,
        metadata: Object.freeze(metadata),
      }));
    }

    return {
      items: Object.freeze(items),
      confidence: items.length > 0 ? 0.7 : 0,
      extractedAt: Date.now(),
      usedLlm: true,
    };
  } catch {
    return ruleBasedExtract(input);
  }
}

function coerceMetadata(
  raw: Record<string, unknown>,
  schema: ProductTypeSchema | undefined,
): Record<string, MetadataValue> {
  const out: Record<string, MetadataValue> = {};
  const fieldsByKey = new Map<string, FieldDef>();
  if (schema) {
    for (const f of schema.fields) fieldsByKey.set(f.key, f);
  }

  for (const [key, val] of Object.entries(raw)) {
    if (val === null || val === undefined || val === '') continue;
    const field = fieldsByKey.get(key);
    if (!field) {
      // Unknown keys pass through as strings so useful info isn't lost.
      if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
        out[key] = val;
      } else {
        out[key] = String(val);
      }
      continue;
    }

    switch (field.dataType) {
      case 'number': {
        const n = typeof val === 'number' ? val : Number(String(val).replace(/[^0-9.\-]/g, ''));
        if (!Number.isNaN(n)) out[key] = field.isInteger ? Math.trunc(n) : n;
        break;
      }
      case 'boolean': {
        if (typeof val === 'boolean') out[key] = val;
        else out[key] = /^(true|yes|1)$/i.test(String(val));
        break;
      }
      case 'string':
      default: {
        out[key] = String(val);
        break;
      }
    }
  }

  return out;
}

function buildListingContext(listing: ExtractInput['listing']): string {
  const lines: string[] = [];
  lines.push(`Marketplace: ${listing.marketplaceId}`);
  lines.push(`Title: "${listing.title}"`);
  if (listing.description) lines.push(`Description: "${listing.description}"`);
  if (listing.conditionRaw) lines.push(`Condition: ${listing.conditionRaw}`);
  if (listing.categoryRaw) lines.push(`Category: ${listing.categoryRaw}`);
  if (listing.itemCount && listing.itemCount > 1) {
    lines.push(`Listed as lot of ${listing.itemCount} items`);
  }
  lines.push(`Price: $${listing.priceUsd.toFixed(2)}${listing.shippingUsd ? ` + $${listing.shippingUsd.toFixed(2)} shipping` : ''}`);
  if (listing.numBids) lines.push(`Bids: ${listing.numBids} (auction — price may increase)`);
  if (listing.endTime) lines.push(`Ends: ${listing.endTime}`);
  if (listing.seller) lines.push(`Seller: ${listing.seller}`);
  if (listing.imageUrl) lines.push(`Image: ${listing.imageUrl}`);
  if (listing.extra) {
    const entries = Object.entries(listing.extra).sort(([a], [b]) => a.localeCompare(b));
    for (const [k, v] of entries) {
      if (v && k !== 'pc_product_id') {
        lines.push(`${k}: ${v}`);
      }
    }
  }
  return lines.join('\n');
}

function buildSchemaPrompt(schema: readonly ProductTypeSchema[]): string {
  return schema.map((pt) => {
    const lines: string[] = [`- **${pt.name}** (type: \`${pt.id}\`)`];
    if (pt.description) lines.push(`  ${pt.description}`);
    for (const f of pt.fields) {
      if (f.isHidden) continue;
      const flags: string[] = [];
      if (f.isRequired) flags.push('required');
      if (f.isIdentifier) flags.push('identifier');
      if (f.isPricingAxis) flags.push('pricing-axis');
      const flagStr = flags.length ? ` [${flags.join(', ')}]` : '';
      const unit = f.unit ? ` ${f.unit}` : '';
      const range = [f.minValue, f.maxValue].some((v) => v !== undefined)
        ? ` (${f.minValue ?? '−∞'}..${f.maxValue ?? '+∞'})`
        : '';
      const hint = f.extractHint ? ` — ${f.extractHint}` : '';
      let line = `    - \`${f.key}\` (${f.dataType}${unit}${range}): ${f.label}${flagStr}${hint}`;
      if (f.enumValues?.length) {
        const values = f.enumValues.map((v) => v.value).join(', ');
        line += `\n      values: ${values}`;
      }
      lines.push(line);
    }
    return lines.join('\n');
  }).join('\n');
}

function extractCondition(raw: string, validValues: readonly string[]): string | undefined {
  if (!validValues.length) return undefined;

  const lower = raw.toLowerCase();
  const mapping: Record<string, readonly string[]> = {
    loose: ['loose', 'cartridge only', 'disc only', 'no box', 'raw'],
    cib: ['complete', 'cib', 'box and manual', 'with box', 'with manual'],
    new_sealed: ['sealed', 'new', 'factory sealed', 'shrink'],
    graded: ['graded', 'psa', 'bgs', 'cgc'],
    in_box: ['in box', 'boxed'],
    raw: ['raw', 'ungraded'],
    NM: ['near mint', 'nm'],
    LP: ['lightly played', 'lp'],
    MP: ['moderately played', 'mp'],
    HP: ['heavily played', 'hp'],
    DMG: ['damaged', 'dmg'],
  };

  for (const v of validValues) {
    const hints = mapping[v];
    if (hints && hints.some((k) => lower.includes(k))) return v;
  }
  return undefined;
}

function extractPlatform(title: string, productType: string): string | undefined {
  if (productType !== 'retro_game') return undefined;

  const platforms = [
    { name: 'Nintendo 64', patterns: ['n64', 'nintendo 64'] },
    { name: 'Game Boy', patterns: ['game boy', 'gameboy'] },
    { name: 'Game Boy Advance', patterns: ['gba', 'game boy advance'] },
    { name: 'Super Nintendo', patterns: ['snes', 'super nintendo'] },
    { name: 'NES', patterns: ['nes', 'nintendo entertainment'] },
    { name: 'PlayStation', patterns: ['playstation', 'ps1', 'ps2'] },
    { name: 'Genesis', patterns: ['genesis', 'sega genesis'] },
    { name: 'GameCube', patterns: ['gamecube', 'game cube'] },
    { name: 'Dreamcast', patterns: ['dreamcast'] },
  ];

  for (const p of platforms) {
    if (p.patterns.some((pat) => title.includes(pat))) {
      return p.name;
    }
  }
  return undefined;
}

/** Load the full DB-driven schema set. The pipeline's source of truth. */
export async function getProductTypeSchema(): Promise<ProductTypeSchema[]> {
  return productTypeRepo.getAllSchemas();
}
