/**
 * Seed the DB-driven hierarchical taxonomy.
 *
 * Creates:
 *   1. root node,
 *   2. Google Product Taxonomy top-level categories (stable, canonical),
 *   3. a concrete starting hierarchy for the verticals we already support.
 *
 * All seeded nodes and fields are canonical=true. Safe to re-run — idempotent
 * via unique(parent_id, slug) and unique(node_id, key).
 *
 * Also migrates existing products: for any product whose productTypeId maps
 * onto a leaf in the new taxonomy, set taxonomyNodeId on the product row.
 */

import { eq, sql } from "drizzle-orm";
import { db } from "./client";
import { products, taxonomyNodes, taxonomyNodeFields, taxonomyNodeFieldEnumValues } from "./schema";
import { taxonomyRepo } from "./repos/TaxonomyRepo";
import { log } from "@/lib/logger";

interface EnumSeed {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly displayOrder?: number;
}

interface FieldSeed {
  readonly key: string;
  readonly label: string;
  readonly dataType: "string" | "number" | "boolean";
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
  readonly enumValues?: readonly EnumSeed[];
}

interface NodeSeed {
  readonly slug: string;
  readonly label: string;
  readonly description?: string;
  readonly gptId?: string;
  readonly fields?: readonly FieldSeed[];
  readonly children?: readonly NodeSeed[];
  /** productTypeId of legacy product rows that should be re-parented here. */
  readonly productTypeMapping?: string;
}

// ── Google Product Taxonomy top-level anchors ─────────────────────────
// IDs from the public Google Product Taxonomy. Stable — chosen for breadth.
const GPT_TOP: readonly NodeSeed[] = [
  { slug: "food_beverages_tobacco", label: "Food, Beverages & Tobacco", gptId: "412" },
  { slug: "arts_entertainment", label: "Arts & Entertainment", gptId: "8" },
  { slug: "electronics", label: "Electronics", gptId: "222" },
  { slug: "apparel_accessories", label: "Apparel & Accessories", gptId: "166" },
  { slug: "health_beauty", label: "Health & Beauty", gptId: "469" },
  { slug: "home_garden", label: "Home & Garden", gptId: "536" },
  { slug: "office_products", label: "Office Supplies", gptId: "922" },
  { slug: "toys_games", label: "Toys & Games", gptId: "1239" },
  { slug: "vehicles_parts", label: "Vehicles & Parts", gptId: "888" },
  { slug: "sporting_goods", label: "Sporting Goods", gptId: "988" },
  { slug: "media", label: "Media", gptId: "783" },
  { slug: "religious_ceremonial", label: "Religious & Ceremonial", gptId: "5605" },
  // Collectibles isn't a first-class GPT category at root — it lives under
  // Arts & Entertainment. We synthesize a "collectibles" top-level node for
  // our domain since most of our catalog lives there.
  { slug: "collectibles", label: "Collectibles", description: "Secondary-market collectible items." },
];

// ── Reusable enum presets ─────────────────────────────────────────────

const GAME_CONDITION: readonly EnumSeed[] = [
  { value: "loose", label: "Loose (cart/disc only)", displayOrder: 10 },
  { value: "cib", label: "Complete in box", displayOrder: 20 },
  { value: "new_sealed", label: "New / sealed", displayOrder: 30 },
  { value: "graded", label: "Graded", displayOrder: 40 },
];

const MTG_CONDITION: readonly EnumSeed[] = [
  { value: "NM", label: "Near Mint", displayOrder: 10 },
  { value: "LP", label: "Lightly Played", displayOrder: 20 },
  { value: "MP", label: "Moderately Played", displayOrder: 30 },
  { value: "HP", label: "Heavily Played", displayOrder: 40 },
  { value: "DMG", label: "Damaged", displayOrder: 50 },
];

const POKEMON_CONDITION: readonly EnumSeed[] = [
  { value: "loose", label: "Raw / ungraded", displayOrder: 10 },
  { value: "graded", label: "Graded", displayOrder: 20 },
];

const TCG_GRADING_COMPANY: readonly EnumSeed[] = [
  { value: "PSA", label: "PSA", displayOrder: 10 },
  { value: "BGS", label: "Beckett (BGS)", displayOrder: 20 },
  { value: "CGC", label: "CGC", displayOrder: 30 },
  { value: "SGC", label: "SGC", displayOrder: 40 },
];

// Shared fields at the Trading Card node — children refine with enum values.
const TCG_SHARED_FIELDS: readonly FieldSeed[] = [
  { key: "set_name", label: "Set name", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, isRequired: true, displayPriority: 10 },
  { key: "card_number", label: "Card number", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, isRequired: true, displayPriority: 20, extractHint: "e.g. 020/189" },
  { key: "rarity", label: "Rarity", dataType: "string", displayPriority: 30 },
  { key: "language", label: "Language", dataType: "string", displayPriority: 40 },
  { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5 },
  { key: "grade", label: "Grade", dataType: "number", isPricingAxis: true, minValue: 1, maxValue: 10, displayPriority: 6 },
  { key: "grading_company", label: "Grading company", dataType: "string", isPricingAxis: true, displayPriority: 7, enumValues: TCG_GRADING_COMPANY },
];

// ── Domain hierarchy (below GPT anchors) ──────────────────────────────

const DOMAIN: readonly NodeSeed[] = [
  // Beverages > Alcoholic Beverages > Liquor & Spirits > Whiskey > Bourbon
  {
    slug: "food_beverages_tobacco",
    label: "Food, Beverages & Tobacco",
    children: [
      {
        slug: "beverages",
        label: "Beverages",
        children: [
          {
            slug: "alcoholic_beverages",
            label: "Alcoholic Beverages",
            children: [
              {
                slug: "liquor_spirits",
                label: "Liquor & Spirits",
                children: [
                  {
                    slug: "whiskey",
                    label: "Whiskey",
                    fields: [
                      { key: "distillery", label: "Distillery", dataType: "string", isSearchable: true, searchWeight: 3, isRequired: true, displayPriority: 10 },
                      { key: "age", label: "Age", dataType: "number", isInteger: true, unit: "yr", displayPriority: 20 },
                      { key: "proof", label: "Proof", dataType: "number", displayPriority: 30 },
                      { key: "vintage_year", label: "Vintage year", dataType: "number", isInteger: true, format: "year", displayPriority: 40 },
                    ],
                    children: [
                      {
                        slug: "bourbon",
                        label: "Bourbon",
                        description: "Secondary-market bourbon bottles — single price point per product.",
                        productTypeMapping: "bourbon",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  },

  // Collectibles > Trading Cards, Figures > Funko Pop, Comic Books, Coins
  {
    slug: "collectibles",
    label: "Collectibles",
    children: [
      {
        slug: "trading_cards",
        label: "Trading Cards",
        fields: TCG_SHARED_FIELDS,
        children: [
          {
            slug: "pokemon",
            label: "Pokemon Trading Card Game",
            productTypeMapping: "pokemon_card",
            fields: [
              {
                key: "set_name",
                label: "Set name",
                dataType: "string",
                isSearchable: true,
                searchWeight: 3,
                isIdentifier: true,
                isRequired: true,
                displayPriority: 10,
                enumValues: [
                  { value: "crown_zenith", label: "Crown Zenith", displayOrder: 10 },
                  { value: "darkness_ablaze", label: "Darkness Ablaze", displayOrder: 20 },
                  { value: "evolving_skies", label: "Evolving Skies", displayOrder: 30 },
                  { value: "hidden_fates", label: "Hidden Fates", displayOrder: 40 },
                  { value: "base_set", label: "Base Set", displayOrder: 50 },
                ],
              },
              {
                key: "condition",
                label: "Condition",
                dataType: "string",
                isPricingAxis: true,
                displayPriority: 5,
                enumValues: POKEMON_CONDITION,
              },
            ],
          },
          {
            slug: "mtg",
            label: "Magic: The Gathering",
            productTypeMapping: "mtg_card",
            fields: [
              {
                key: "set_name",
                label: "Set name",
                dataType: "string",
                isSearchable: true,
                searchWeight: 3,
                isIdentifier: true,
                isRequired: true,
                displayPriority: 10,
                enumValues: [
                  { value: "modern_horizons_3", label: "Modern Horizons 3", displayOrder: 10 },
                  { value: "lord_of_the_rings", label: "Lord of the Rings", displayOrder: 20 },
                  { value: "wilds_of_eldraine", label: "Wilds of Eldraine", displayOrder: 30 },
                ],
              },
              {
                key: "condition",
                label: "Condition",
                dataType: "string",
                isPricingAxis: true,
                displayPriority: 5,
                enumValues: MTG_CONDITION,
              },
              { key: "set_code", label: "Set code", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, displayPriority: 11 },
              { key: "finish", label: "Finish", dataType: "string", displayPriority: 31, enumValues: [
                { value: "nonfoil", label: "Non-foil" },
                { value: "foil", label: "Foil" },
                { value: "etched", label: "Etched foil" },
              ] },
            ],
          },
          {
            slug: "yugioh",
            label: "Yu-Gi-Oh!",
            productTypeMapping: "yugioh_card",
            fields: [
              { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: MTG_CONDITION },
            ],
          },
          {
            slug: "one_piece",
            label: "One Piece Card Game",
            productTypeMapping: "onepiece_card",
            fields: [
              { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: MTG_CONDITION },
            ],
          },
          {
            slug: "sports_cards",
            label: "Sports Cards",
            productTypeMapping: "sports_card",
            fields: [
              { key: "player", label: "Player", dataType: "string", isSearchable: true, searchWeight: 3, isRequired: true, displayPriority: 10 },
              { key: "year", label: "Year", dataType: "number", isInteger: true, format: "year", isIdentifier: true, displayPriority: 20 },
              { key: "brand", label: "Brand", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 30 },
              { key: "rookie", label: "Rookie", dataType: "boolean", displayPriority: 50 },
              { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: [
                { value: "raw", label: "Raw / ungraded", displayOrder: 10 },
                { value: "graded", label: "Graded", displayOrder: 20 },
              ] },
            ],
          },
        ],
      },
      {
        slug: "figures",
        label: "Collectible Figures",
        children: [
          {
            slug: "funko_pop",
            label: "Funko Pop",
            productTypeMapping: "funko_pop",
            fields: [
              { key: "series", label: "Series", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 10 },
              { key: "number", label: "Number", dataType: "string", isIdentifier: true, displayPriority: 20 },
              { key: "exclusive", label: "Exclusive", dataType: "boolean", displayPriority: 30 },
              { key: "chase", label: "Chase", dataType: "boolean", displayPriority: 40 },
              { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: [
                { value: "loose", label: "Loose / out of box", displayOrder: 10 },
                { value: "in_box", label: "In box", displayOrder: 20 },
                { value: "graded", label: "Graded", displayOrder: 30 },
              ] },
            ],
          },
        ],
      },
      {
        slug: "comic_books",
        label: "Comic Books",
        productTypeMapping: "comic",
        fields: [
          { key: "publisher", label: "Publisher", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 10 },
          { key: "issue", label: "Issue", dataType: "string", isIdentifier: true, displayPriority: 20 },
          { key: "year", label: "Year", dataType: "number", isInteger: true, format: "year", displayPriority: 30 },
          { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: [
            { value: "raw", label: "Raw / ungraded", displayOrder: 10 },
            { value: "graded", label: "Graded (slabbed)", displayOrder: 20 },
          ] },
          { key: "grade", label: "Grade", dataType: "number", isPricingAxis: true, minValue: 0.5, maxValue: 10, displayPriority: 6 },
          { key: "grading_company", label: "Grading company", dataType: "string", isPricingAxis: true, displayPriority: 7 },
        ],
      },
      {
        slug: "coins",
        label: "Coins",
        productTypeMapping: "coin",
        fields: [
          { key: "year", label: "Year", dataType: "number", isInteger: true, format: "year", displayPriority: 10 },
          { key: "mint", label: "Mint mark", dataType: "string", displayPriority: 20 },
          { key: "denomination", label: "Denomination", dataType: "string", displayPriority: 30 },
          { key: "grade", label: "Grade", dataType: "number", isPricingAxis: true, minValue: 1, maxValue: 70, displayPriority: 5 },
          { key: "grading_company", label: "Grading company", dataType: "string", isPricingAxis: true, displayPriority: 6 },
        ],
      },
    ],
  },

  // Electronics > Video Games > Physical Game Media (retro games)
  {
    slug: "electronics",
    label: "Electronics",
    children: [
      {
        slug: "video_games",
        label: "Video Games",
        children: [
          {
            slug: "physical_game_media",
            label: "Physical Game Media",
            description: "Cartridge/disc-based console video games.",
            productTypeMapping: "retro_game",
            fields: [
              { key: "title", label: "Title", dataType: "string", isSearchable: true, searchWeight: 3, isRequired: true, displayPriority: 10, extractHint: "canonical product name" },
              { key: "platform", label: "Platform", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 20, enumValues: [
                { value: "nintendo_64", label: "Nintendo 64", displayOrder: 10 },
                { value: "snes", label: "Super Nintendo", displayOrder: 20 },
                { value: "nes", label: "NES", displayOrder: 30 },
                { value: "gamecube", label: "GameCube", displayOrder: 40 },
                { value: "game_boy", label: "Game Boy", displayOrder: 50 },
                { value: "game_boy_advance", label: "Game Boy Advance", displayOrder: 60 },
                { value: "playstation", label: "PlayStation", displayOrder: 70 },
                { value: "genesis", label: "Sega Genesis", displayOrder: 80 },
                { value: "dreamcast", label: "Dreamcast", displayOrder: 90 },
              ] },
              { key: "release_date", label: "Release date", dataType: "string", format: "date", displayPriority: 30 },
              { key: "genre", label: "Genre", dataType: "string", displayPriority: 40 },
              { key: "region", label: "Region", dataType: "string", displayPriority: 50 },
              { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: GAME_CONDITION },
            ],
          },
        ],
      },
    ],
  },

  // Toys & Games > Building Sets > LEGO
  {
    slug: "toys_games",
    label: "Toys & Games",
    children: [
      {
        slug: "building_sets",
        label: "Building Sets",
        children: [
          {
            slug: "lego",
            label: "LEGO",
            productTypeMapping: "lego_set",
            fields: [
              { key: "theme", label: "Theme", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 10 },
              { key: "set_number", label: "Set number", dataType: "string", isIdentifier: true, isSearchable: true, searchWeight: 3, displayPriority: 20 },
              { key: "piece_count", label: "Piece count", dataType: "number", isInteger: true, displayPriority: 30 },
              { key: "year", label: "Year", dataType: "number", isInteger: true, format: "year", displayPriority: 40 },
              { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: [
                { value: "loose", label: "Loose / built", displayOrder: 10 },
                { value: "cib", label: "Complete in box", displayOrder: 20 },
                { value: "new_sealed", label: "New / sealed", displayOrder: 30 },
              ] },
            ],
          },
        ],
      },
    ],
  },
];

export interface SeedResult {
  readonly nodes: number;
  readonly fields: number;
  readonly enumValues: number;
  readonly productsLinked: number;
}

export async function seedTaxonomy(): Promise<SeedResult> {
  let nodeCount = 0;
  let fieldCount = 0;
  let enumCount = 0;

  // 1. Ensure root.
  let root = await db.query.taxonomyNodes.findFirst({
    where: (t, { isNull }) => isNull(t.parentId),
  });
  if (!root) {
    const now = new Date().toISOString();
    const [row] = await db
      .insert(taxonomyNodes)
      .values({
        parentId: null,
        slug: "root",
        label: "Root",
        description: "Top of the taxonomy tree.",
        pathCache: "/root",
        createdAt: now,
        createdBy: "seed",
        canonical: true,
        observationCount: 0,
      })
      .returning();
    root = row;
    nodeCount++;
  }

  const rootId = root.id;

  // 2. GPT anchors — mount directly under root.
  const anchorIds = new Map<string, number>();
  for (const top of GPT_TOP) {
    const id = await ensureNode({
      parentId: rootId,
      slug: top.slug,
      label: top.label,
      description: top.description,
      gptId: top.gptId,
    });
    anchorIds.set(top.slug, id);
    nodeCount++;
  }

  // 3. Domain hierarchy — each DOMAIN entry's slug is an anchor slug.
  const legacyTypeMappings = new Map<string, number>();

  async function walk(parentId: number, node: NodeSeed): Promise<number> {
    const id = await ensureNode({
      parentId,
      slug: node.slug,
      label: node.label,
      description: node.description,
      gptId: node.gptId,
    });
    nodeCount++;

    if (node.fields) {
      for (const f of node.fields) {
        const { field, created } = await ensureField(id, f);
        if (created) fieldCount++;
        if (f.enumValues?.length) {
          for (const [i, ev] of f.enumValues.entries()) {
            const inserted = await ensureEnumValue(field.id, ev, i);
            if (inserted) enumCount++;
          }
        }
      }
    }

    if (node.productTypeMapping) {
      legacyTypeMappings.set(node.productTypeMapping, id);
    }

    if (node.children) {
      for (const child of node.children) {
        await walk(id, child);
      }
    }

    return id;
  }

  for (const top of DOMAIN) {
    const anchorId = anchorIds.get(top.slug);
    if (!anchorId) {
      throw new Error(`seed-taxonomy: no GPT anchor for ${top.slug}`);
    }
    if (top.children) {
      for (const child of top.children) {
        await walk(anchorId, child);
      }
    }
    if (top.fields) {
      for (const f of top.fields) {
        const { field, created } = await ensureField(anchorId, f);
        if (created) fieldCount++;
        if (f.enumValues?.length) {
          for (const [i, ev] of f.enumValues.entries()) {
            const inserted = await ensureEnumValue(field.id, ev, i);
            if (inserted) enumCount++;
          }
        }
      }
    }
  }

  // 4. Migrate existing products: set taxonomyNodeId based on productTypeId.
  let productsLinked = 0;
  for (const [productTypeId, nodeId] of legacyTypeMappings) {
    const res = await db
      .update(products)
      .set({ taxonomyNodeId: nodeId })
      .where(
        sql`${products.productTypeId} = ${productTypeId} AND (${products.taxonomyNodeId} IS NULL)`,
      );
    // better-sqlite3 doesn't return affected on update via drizzle — do a
    // count query to report progress.
    void res;
    const [{ cnt }] = await db
      .select({ cnt: sql<number>`count(*)` })
      .from(products)
      .where(eq(products.productTypeId, productTypeId));
    productsLinked += cnt;
  }

  log(
    "seed-taxonomy",
    `nodes: ${nodeCount} | fields: ${fieldCount} | enum values: ${enumCount} | products linked: ${productsLinked}`,
  );
  return { nodes: nodeCount, fields: fieldCount, enumValues: enumCount, productsLinked };
}

// ── Helpers ───────────────────────────────────────────────────────────

async function ensureNode(params: {
  readonly parentId: number;
  readonly slug: string;
  readonly label: string;
  readonly description?: string;
  readonly gptId?: string;
}): Promise<number> {
  const existing = await db.query.taxonomyNodes.findFirst({
    where: (t, { and, eq }) =>
      and(eq(t.parentId, params.parentId), eq(t.slug, params.slug)),
  });
  if (existing) {
    // Keep label/description in sync with seed source of truth.
    if (
      existing.label !== params.label ||
      (existing.description ?? null) !== (params.description ?? null) ||
      (existing.gptId ?? null) !== (params.gptId ?? null)
    ) {
      await db
        .update(taxonomyNodes)
        .set({
          label: params.label,
          description: params.description,
          gptId: params.gptId,
        })
        .where(eq(taxonomyNodes.id, existing.id));
    }
    return existing.id;
  }

  const node = await taxonomyRepo.createNode(
    {
      parentId: params.parentId,
      slug: params.slug,
      label: params.label,
      description: params.description,
      gptId: params.gptId,
      canonical: true,
    },
    "seed",
  );
  return node.id;
}

async function ensureField(
  nodeId: number,
  f: FieldSeed,
): Promise<{ field: { id: number }; created: boolean }> {
  const existing = await db.query.taxonomyNodeFields.findFirst({
    where: (t, { and, eq }) => and(eq(t.nodeId, nodeId), eq(t.key, f.key)),
  });
  if (existing) {
    // Sync mutable properties.
    await db
      .update(taxonomyNodeFields)
      .set({
        label: f.label,
        dataType: f.dataType,
        pattern: f.pattern,
        minValue: f.minValue,
        maxValue: f.maxValue,
        isInteger: f.isInteger ?? false,
        format: f.format,
        unit: f.unit,
        extractHint: f.extractHint,
        isRequired: f.isRequired ?? false,
        isSearchable: f.isSearchable ?? false,
        searchWeight: f.searchWeight ?? 1,
        isIdentifier: f.isIdentifier ?? false,
        isPricingAxis: f.isPricingAxis ?? false,
        displayPriority: f.displayPriority ?? 100,
        isHidden: f.isHidden ?? false,
        canonical: true,
      })
      .where(eq(taxonomyNodeFields.id, existing.id));
    return { field: { id: existing.id }, created: false };
  }
  const field = await taxonomyRepo.createField(
    {
      nodeId,
      key: f.key,
      label: f.label,
      dataType: f.dataType,
      pattern: f.pattern,
      minValue: f.minValue,
      maxValue: f.maxValue,
      isInteger: f.isInteger,
      format: f.format,
      unit: f.unit,
      extractHint: f.extractHint,
      isRequired: f.isRequired,
      isSearchable: f.isSearchable,
      searchWeight: f.searchWeight,
      isIdentifier: f.isIdentifier,
      isPricingAxis: f.isPricingAxis,
      displayPriority: f.displayPriority,
      isHidden: f.isHidden,
      canonical: true,
    },
    "seed",
  );
  return { field: { id: field.id }, created: true };
}

async function ensureEnumValue(
  fieldId: number,
  ev: EnumSeed,
  index: number,
): Promise<boolean> {
  const existing = await db.query.taxonomyNodeFieldEnumValues.findFirst({
    where: (t, { and, eq }) =>
      and(eq(t.fieldId, fieldId), eq(t.value, ev.value)),
  });
  if (existing) {
    if (
      existing.label !== ev.label ||
      (existing.description ?? null) !== (ev.description ?? null)
    ) {
      await db
        .update(taxonomyNodeFieldEnumValues)
        .set({
          label: ev.label,
          description: ev.description,
          displayOrder: ev.displayOrder ?? (index + 1) * 10,
        })
        .where(eq(taxonomyNodeFieldEnumValues.id, existing.id));
    }
    return false;
  }
  await db.insert(taxonomyNodeFieldEnumValues).values({
    fieldId,
    value: ev.value,
    label: ev.label,
    description: ev.description,
    displayOrder: ev.displayOrder ?? (index + 1) * 10,
  });
  return true;
}
