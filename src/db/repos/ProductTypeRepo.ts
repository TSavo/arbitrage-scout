import { asc, eq } from "drizzle-orm";
import { db } from "../client";
import {
  productTypes,
  productTypeFields,
  productTypeFieldEnumValues,
} from "../schema";
import type { IRepository } from "./IRepository";

export type ProductType = typeof productTypes.$inferSelect;
export type NewProductType = typeof productTypes.$inferInsert;
export type ProductTypeField = typeof productTypeFields.$inferSelect;
export type NewProductTypeField = typeof productTypeFields.$inferInsert;
export type ProductTypeFieldEnumValue =
  typeof productTypeFieldEnumValues.$inferSelect;
export type NewProductTypeFieldEnumValue =
  typeof productTypeFieldEnumValues.$inferInsert;

// ── Immutable DTOs for the schema API ────────────────────────────────

export type FieldDataType = "string" | "number" | "boolean";

export interface FieldEnumValue {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly displayOrder: number;
}

export interface FieldDef {
  readonly key: string;
  readonly label: string;
  readonly dataType: FieldDataType;
  readonly pattern?: string;
  readonly minValue?: number;
  readonly maxValue?: number;
  readonly isInteger: boolean;
  readonly format?: string;
  readonly unit?: string;
  readonly extractHint?: string;
  readonly isRequired: boolean;
  readonly isSearchable: boolean;
  readonly searchWeight: number;
  readonly isIdentifier: boolean;
  readonly isPricingAxis: boolean;
  readonly displayPriority: number;
  readonly isHidden: boolean;
  readonly enumValues?: ReadonlyArray<FieldEnumValue>;
}

export interface ProductTypeSchema {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly fields: readonly FieldDef[];
}

function toFieldDef(
  row: ProductTypeField,
  enums: readonly ProductTypeFieldEnumValue[],
): FieldDef {
  const enumValues = enums
    .map<FieldEnumValue>((e) => ({
      value: e.value,
      label: e.label,
      description: e.description ?? undefined,
      displayOrder: e.displayOrder,
    }))
    .sort((a, b) => a.displayOrder - b.displayOrder);

  return Object.freeze({
    key: row.key,
    label: row.label,
    dataType: row.dataType as FieldDataType,
    pattern: row.pattern ?? undefined,
    minValue: row.minValue ?? undefined,
    maxValue: row.maxValue ?? undefined,
    isInteger: row.isInteger,
    format: row.format ?? undefined,
    unit: row.unit ?? undefined,
    extractHint: row.extractHint ?? undefined,
    isRequired: row.isRequired,
    isSearchable: row.isSearchable,
    searchWeight: row.searchWeight,
    isIdentifier: row.isIdentifier,
    isPricingAxis: row.isPricingAxis,
    displayPriority: row.displayPriority,
    isHidden: row.isHidden,
    enumValues: enumValues.length ? Object.freeze(enumValues) : undefined,
  });
}

export class ProductTypeRepo implements IRepository<ProductType, string> {
  async findById(id: string): Promise<ProductType | null> {
    const row = await db.query.productTypes.findFirst({
      where: eq(productTypes.id, id),
    });
    return row ?? null;
  }

  async findAll(opts?: { limit?: number; offset?: number }): Promise<ProductType[]> {
    return db.query.productTypes.findMany({
      limit: opts?.limit,
      offset: opts?.offset,
      orderBy: (t, { asc }) => [asc(t.name)],
    });
  }

  async create(data: Omit<ProductType, "id"> & { id: string }): Promise<ProductType> {
    const [row] = await db.insert(productTypes).values(data as NewProductType).returning();
    return row;
  }

  async update(id: string, data: Partial<ProductType>): Promise<ProductType | null> {
    const [row] = await db
      .update(productTypes)
      .set(data)
      .where(eq(productTypes.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(productTypes)
      .where(eq(productTypes.id, id))
      .returning({ id: productTypes.id });
    return result.length > 0;
  }

  async count(): Promise<number> {
    const rows = await db.select({ id: productTypes.id }).from(productTypes);
    return rows.length;
  }

  /** Returns the full DB-driven schema (fields + enum values) for a product type. */
  async getSchema(typeId: string): Promise<ProductTypeSchema | null> {
    const pt = await this.findById(typeId);
    if (!pt) return null;

    const fieldRows = await db
      .select()
      .from(productTypeFields)
      .where(eq(productTypeFields.productTypeId, typeId))
      .orderBy(asc(productTypeFields.displayPriority), asc(productTypeFields.id));

    const fieldIds = fieldRows.map((f) => f.id);
    const enumRows = fieldIds.length
      ? await db
          .select()
          .from(productTypeFieldEnumValues)
      : [];

    const enumsByField = new Map<number, ProductTypeFieldEnumValue[]>();
    for (const e of enumRows) {
      const list = enumsByField.get(e.fieldId) ?? [];
      list.push(e);
      enumsByField.set(e.fieldId, list);
    }

    const fields = fieldRows.map((f) => toFieldDef(f, enumsByField.get(f.id) ?? []));

    return Object.freeze({
      id: pt.id,
      name: pt.name,
      description: pt.description ?? undefined,
      fields: Object.freeze(fields),
    });
  }

  /** Returns schemas for all product types in alphabetical order. */
  async getAllSchemas(): Promise<ProductTypeSchema[]> {
    const types = await this.findAll();
    const out: ProductTypeSchema[] = [];
    for (const pt of types) {
      const s = await this.getSchema(pt.id);
      if (s) out.push(s);
    }
    return out;
  }

  /** Upsert a field definition. */
  async upsertField(
    data: Omit<NewProductTypeField, "id">,
  ): Promise<ProductTypeField> {
    const existing = await db.query.productTypeFields.findFirst({
      where: (t, { and, eq: eqOp }) =>
        and(
          eqOp(t.productTypeId, data.productTypeId),
          eqOp(t.key, data.key),
        ),
    });

    if (existing) {
      const [row] = await db
        .update(productTypeFields)
        .set(data)
        .where(eq(productTypeFields.id, existing.id))
        .returning();
      return row;
    }

    const [row] = await db.insert(productTypeFields).values(data).returning();
    return row;
  }

  /** Replace all enum values for a field. */
  async setFieldEnumValues(
    fieldId: number,
    values: ReadonlyArray<Omit<NewProductTypeFieldEnumValue, "id" | "fieldId">>,
  ): Promise<void> {
    await db
      .delete(productTypeFieldEnumValues)
      .where(eq(productTypeFieldEnumValues.fieldId, fieldId));

    if (values.length === 0) return;

    await db
      .insert(productTypeFieldEnumValues)
      .values(values.map((v) => ({ ...v, fieldId })));
  }
}

export const productTypeRepo = new ProductTypeRepo();
