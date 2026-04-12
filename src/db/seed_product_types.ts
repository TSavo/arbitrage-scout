/**
 * DB-driven product type schema seed.
 *
 * Populates product_types, product_type_fields, and
 * product_type_field_enum_values so the pipeline can drive extraction,
 * matching, and pricing entirely from the DB — no hardcoded strings.
 *
 * Idempotent: safe to re-run. Existing fields are upserted by (type, key).
 */

import { db } from "./client";
import { productTypes } from "./schema";
import { eq } from "drizzle-orm";
import {
  productTypeRepo,
  type NewProductTypeField,
  type NewProductTypeFieldEnumValue,
} from "./repos/ProductTypeRepo";
import { log } from "@/lib/logger";

// ── Field definitions ────────────────────────────────────────────────

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

interface TypeSeed {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly fields: readonly FieldSeed[];
}

// ── Reusable field/enum presets ──────────────────────────────────────

const GAME_CONDITION: EnumSeed[] = [
  { value: "loose", label: "Loose (cart/disc only)", displayOrder: 10 },
  { value: "cib", label: "Complete in box", displayOrder: 20 },
  { value: "new_sealed", label: "New / sealed", displayOrder: 30 },
  { value: "graded", label: "Graded", displayOrder: 40 },
  { value: "box_only", label: "Box only", displayOrder: 50 },
  { value: "manual_only", label: "Manual only", displayOrder: 60 },
];

const MTG_CONDITION: EnumSeed[] = [
  { value: "NM", label: "Near Mint", displayOrder: 10 },
  { value: "LP", label: "Lightly Played", displayOrder: 20 },
  { value: "MP", label: "Moderately Played", displayOrder: 30 },
  { value: "HP", label: "Heavily Played", displayOrder: 40 },
  { value: "DMG", label: "Damaged", displayOrder: 50 },
];

const POKEMON_CONDITION: EnumSeed[] = [
  { value: "loose", label: "Raw / ungraded", displayOrder: 10 },
  { value: "graded", label: "Graded", displayOrder: 20 },
];

const GRADING_COMPANY: EnumSeed[] = [
  { value: "PSA", label: "PSA", displayOrder: 10 },
  { value: "BGS", label: "Beckett (BGS)", displayOrder: 20 },
  { value: "CGC", label: "CGC", displayOrder: 30 },
  { value: "SGC", label: "SGC", displayOrder: 40 },
];

// ── Types ────────────────────────────────────────────────────────────

const TYPES: TypeSeed[] = [
  // ── Retro game ──
  {
    id: "retro_game",
    name: "Retro Video Game",
    description: "Cartridge/disc-based console video games.",
    fields: [
      { key: "title", label: "Title", dataType: "string", isSearchable: true, searchWeight: 3, isRequired: true, displayPriority: 10, extractHint: "canonical product name, e.g. 'Super Mario 64'" },
      { key: "platform", label: "Platform", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 20, extractHint: "console, e.g. 'Nintendo 64', 'PlayStation'" },
      { key: "release_date", label: "Release date", dataType: "string", format: "date", displayPriority: 30 },
      { key: "genre", label: "Genre", dataType: "string", displayPriority: 40 },
      { key: "region", label: "Region", dataType: "string", displayPriority: 50, extractHint: "NTSC, PAL, JP" },
      { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: GAME_CONDITION },
    ],
  },
  // ── Pokemon card ──
  {
    id: "pokemon_card",
    name: "Pokemon Card",
    fields: [
      { key: "set_name", label: "Set name", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, isRequired: true, displayPriority: 10 },
      { key: "card_number", label: "Card number", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, isRequired: true, displayPriority: 20, extractHint: "e.g. 020/189" },
      { key: "rarity", label: "Rarity", dataType: "string", displayPriority: 30, enumValues: [
        { value: "common", label: "Common" },
        { value: "uncommon", label: "Uncommon" },
        { value: "rare", label: "Rare" },
        { value: "holo_rare", label: "Holo Rare" },
        { value: "ultra_rare", label: "Ultra Rare" },
        { value: "secret_rare", label: "Secret Rare" },
      ] },
      { key: "language", label: "Language", dataType: "string", displayPriority: 40 },
      { key: "edition", label: "Edition", dataType: "string", displayPriority: 50, extractHint: "1st edition, unlimited" },
      { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: POKEMON_CONDITION },
      { key: "grade", label: "Grade", dataType: "number", isPricingAxis: true, minValue: 1, maxValue: 10, displayPriority: 6 },
      { key: "grading_company", label: "Grading company", dataType: "string", isPricingAxis: true, displayPriority: 7, enumValues: GRADING_COMPANY },
    ],
  },
  // ── MTG ──
  {
    id: "mtg_card",
    name: "Magic: The Gathering Card",
    fields: [
      { key: "set_code", label: "Set code", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, displayPriority: 10 },
      { key: "set_name", label: "Set name", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 15 },
      { key: "collector_number", label: "Collector number", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, displayPriority: 20 },
      { key: "finish", label: "Finish", dataType: "string", displayPriority: 30, enumValues: [
        { value: "nonfoil", label: "Non-foil" },
        { value: "foil", label: "Foil" },
        { value: "etched", label: "Etched foil" },
      ] },
      { key: "rarity", label: "Rarity", dataType: "string", displayPriority: 40, enumValues: [
        { value: "common", label: "Common" },
        { value: "uncommon", label: "Uncommon" },
        { value: "rare", label: "Rare" },
        { value: "mythic", label: "Mythic" },
      ] },
      { key: "language", label: "Language", dataType: "string", displayPriority: 50 },
      { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: MTG_CONDITION },
    ],
  },
  // ── Yu-Gi-Oh ──
  {
    id: "yugioh_card",
    name: "Yu-Gi-Oh! Card",
    fields: [
      { key: "set_name", label: "Set name", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, displayPriority: 10 },
      { key: "card_number", label: "Card number", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, displayPriority: 20 },
      { key: "rarity", label: "Rarity", dataType: "string", displayPriority: 30 },
      { key: "language", label: "Language", dataType: "string", displayPriority: 40 },
      { key: "edition", label: "Edition", dataType: "string", displayPriority: 50 },
      { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: MTG_CONDITION },
    ],
  },
  // ── One Piece TCG ──
  {
    id: "onepiece_card",
    name: "One Piece Card",
    fields: [
      { key: "set_name", label: "Set name", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, displayPriority: 10 },
      { key: "card_number", label: "Card number", dataType: "string", isSearchable: true, searchWeight: 3, isIdentifier: true, displayPriority: 20 },
      { key: "rarity", label: "Rarity", dataType: "string", displayPriority: 30 },
      { key: "language", label: "Language", dataType: "string", displayPriority: 40 },
      { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: MTG_CONDITION },
    ],
  },
  // ── Funko Pop ──
  {
    id: "funko_pop",
    name: "Funko Pop",
    fields: [
      { key: "series", label: "Series", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 10 },
      { key: "number", label: "Number", dataType: "string", isIdentifier: true, displayPriority: 20 },
      { key: "exclusive", label: "Exclusive", dataType: "boolean", displayPriority: 30 },
      { key: "chase", label: "Chase", dataType: "boolean", displayPriority: 40 },
      { key: "variant", label: "Variant", dataType: "string", displayPriority: 50 },
      { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: [
        { value: "loose", label: "Loose / out of box", displayOrder: 10 },
        { value: "in_box", label: "In box", displayOrder: 20 },
        { value: "graded", label: "Graded", displayOrder: 30 },
      ] },
    ],
  },
  // ── Lego set ──
  {
    id: "lego_set",
    name: "Lego Set",
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
  // ── Comic book ──
  {
    id: "comic",
    name: "Comic Book",
    fields: [
      { key: "publisher", label: "Publisher", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 10 },
      { key: "issue", label: "Issue", dataType: "string", isIdentifier: true, displayPriority: 20 },
      { key: "year", label: "Year", dataType: "number", isInteger: true, format: "year", displayPriority: 30 },
      { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: [
        { value: "raw", label: "Raw / ungraded", displayOrder: 10 },
        { value: "graded", label: "Graded (slabbed)", displayOrder: 20 },
      ] },
      { key: "grade", label: "Grade", dataType: "number", isPricingAxis: true, minValue: 0.5, maxValue: 10, displayPriority: 6 },
      { key: "grading_company", label: "Grading company", dataType: "string", isPricingAxis: true, displayPriority: 7, enumValues: [
        { value: "CGC", label: "CGC" },
        { value: "CBCS", label: "CBCS" },
        { value: "PGX", label: "PGX" },
      ] },
    ],
  },
  // ── Coin ──
  {
    id: "coin",
    name: "Coin",
    fields: [
      { key: "year", label: "Year", dataType: "number", isInteger: true, format: "year", displayPriority: 10 },
      { key: "mint", label: "Mint mark", dataType: "string", displayPriority: 20 },
      { key: "denomination", label: "Denomination", dataType: "string", displayPriority: 30 },
      { key: "grade", label: "Grade", dataType: "number", isPricingAxis: true, minValue: 1, maxValue: 70, displayPriority: 5 },
      { key: "grading_company", label: "Grading company", dataType: "string", isPricingAxis: true, displayPriority: 6, enumValues: [
        { value: "PCGS", label: "PCGS" },
        { value: "NGC", label: "NGC" },
        { value: "ANACS", label: "ANACS" },
      ] },
    ],
  },
  // ── Sports card ──
  {
    id: "sports_card",
    name: "Sports Card",
    fields: [
      { key: "player", label: "Player", dataType: "string", isSearchable: true, searchWeight: 3, isRequired: true, displayPriority: 10 },
      { key: "year", label: "Year", dataType: "number", isInteger: true, format: "year", isIdentifier: true, displayPriority: 20 },
      { key: "brand", label: "Brand", dataType: "string", isSearchable: true, searchWeight: 2, displayPriority: 30 },
      { key: "variant", label: "Variant", dataType: "string", displayPriority: 40, enumValues: [
        { value: "base", label: "Base" },
        { value: "chrome", label: "Chrome" },
        { value: "refractor", label: "Refractor" },
        { value: "prizm", label: "Prizm" },
        { value: "silver", label: "Silver" },
        { value: "gold", label: "Gold" },
      ] },
      { key: "rookie", label: "Rookie", dataType: "boolean", displayPriority: 50 },
      { key: "autograph", label: "Autograph", dataType: "boolean", displayPriority: 60 },
      { key: "condition", label: "Condition", dataType: "string", isPricingAxis: true, displayPriority: 5, enumValues: [
        { value: "raw", label: "Raw / ungraded", displayOrder: 10 },
        { value: "graded", label: "Graded", displayOrder: 20 },
      ] },
      { key: "grade", label: "Grade", dataType: "number", isPricingAxis: true, minValue: 1, maxValue: 10, displayPriority: 6 },
      { key: "grading_company", label: "Grading company", dataType: "string", isPricingAxis: true, displayPriority: 7, enumValues: GRADING_COMPANY },
    ],
  },
  // ── Bourbon (no pricing axes) ──
  {
    id: "bourbon",
    name: "Bourbon",
    description: "Secondary-market bourbon bottles — single price point per product.",
    fields: [
      { key: "distillery", label: "Distillery", dataType: "string", isSearchable: true, searchWeight: 3, isRequired: true, displayPriority: 10 },
      { key: "age", label: "Age", dataType: "number", isInteger: true, unit: "yr", displayPriority: 20 },
      { key: "proof", label: "Proof", dataType: "number", displayPriority: 30 },
      { key: "vintage_year", label: "Vintage year", dataType: "number", isInteger: true, format: "year", displayPriority: 40 },
    ],
  },
];

// ── Seed runner ──────────────────────────────────────────────────────

export async function seedProductTypes(): Promise<{
  types: number;
  fields: number;
  enumValues: number;
}> {
  let typesCount = 0;
  let fieldsCount = 0;
  let enumValuesCount = 0;

  for (const type of TYPES) {
    const existing = await db.query.productTypes.findFirst({
      where: eq(productTypes.id, type.id),
    });

    if (!existing) {
      await db.insert(productTypes).values({
        id: type.id,
        name: type.name,
        description: type.description,
      });
    } else if (existing.name !== type.name || existing.description !== (type.description ?? null)) {
      await db
        .update(productTypes)
        .set({ name: type.name, description: type.description })
        .where(eq(productTypes.id, type.id));
    }
    typesCount++;

    for (const f of type.fields) {
      const fieldData: Omit<typeof import("./schema").productTypeFields.$inferInsert, "id"> = {
        productTypeId: type.id,
        key: f.key,
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
      };

      const field = await productTypeRepo.upsertField(fieldData as NewProductTypeField);
      fieldsCount++;

      if (f.enumValues && f.enumValues.length) {
        const enumInputs: Array<Omit<NewProductTypeFieldEnumValue, "id" | "fieldId">> =
          f.enumValues.map((ev, i) => ({
            value: ev.value,
            label: ev.label,
            description: ev.description,
            displayOrder: ev.displayOrder ?? (i + 1) * 10,
          }));
        await productTypeRepo.setFieldEnumValues(field.id, enumInputs);
        enumValuesCount += enumInputs.length;
      }
    }
  }

  log("seed", `product types: ${typesCount} | fields: ${fieldsCount} | enum values: ${enumValuesCount}`);
  return { types: typesCount, fields: fieldsCount, enumValues: enumValuesCount };
}
