/**
 * TaxonomyRepo — DB-driven hierarchical product taxonomy.
 *
 * The taxonomy is a tree. Fields attach to nodes and are inherited by
 * descendants. The accumulated schema for a node is the union of fields along
 * its path from root, with deepest-wins (replace) semantics for duplicate keys.
 *
 * Enum values are scoped: when a field is defined at an ancestor but the
 * concrete valid values depend on a descendant (e.g. Trading Card > set_name
 * with enum values for Pokemon vs MTG), the deepest node on the path that has
 * enum values for that field key wins.
 *
 * Only this repo (and SchemaGrowthService, which it supports) touches the
 * taxonomy_* tables. No raw SQL anywhere except `db/client.ts`.
 */

import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../client";
import {
  taxonomyNodes,
  taxonomyNodeFields,
  taxonomyNodeFieldEnumValues,
  schemaVersions,
} from "../schema";

export type FieldDataType = "string" | "number" | "boolean";

export interface TaxonomyNode {
  readonly id: number;
  readonly parentId: number | null;
  readonly slug: string;
  readonly label: string;
  readonly description?: string;
  readonly gptId?: string;
  readonly pathCache: string;
  readonly canonical: boolean;
  readonly observationCount: number;
  readonly lastObservedAt?: string;
  readonly createdAt: string;
  readonly createdBy: string;
}

export interface EnumValue {
  readonly id: number;
  readonly fieldId: number;
  readonly value: string;
  readonly label: string;
  readonly description?: string;
  readonly displayOrder: number;
}

export interface FieldDef {
  readonly id: number;
  readonly nodeId: number;
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
  readonly canonical: boolean;
  readonly observationCount: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly enumValues: ReadonlyArray<EnumValue>;
}

export interface AccumulatedSchema {
  readonly path: ReadonlyArray<TaxonomyNode>;
  readonly fields: ReadonlyArray<FieldDef>;
}

export interface CreateNodeParams {
  readonly parentId: number | null;
  readonly slug: string;
  readonly label: string;
  readonly description?: string;
  readonly gptId?: string;
  readonly canonical?: boolean;
}

export interface CreateFieldParams {
  readonly nodeId: number;
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
  readonly canonical?: boolean;
}

type NodeRow = typeof taxonomyNodes.$inferSelect;
type FieldRow = typeof taxonomyNodeFields.$inferSelect;
type EnumRow = typeof taxonomyNodeFieldEnumValues.$inferSelect;

function nodeFrom(row: NodeRow): TaxonomyNode {
  return Object.freeze({
    id: row.id,
    parentId: row.parentId ?? null,
    slug: row.slug,
    label: row.label,
    description: row.description ?? undefined,
    gptId: row.gptId ?? undefined,
    pathCache: row.pathCache,
    canonical: row.canonical,
    observationCount: row.observationCount,
    lastObservedAt: row.lastObservedAt ?? undefined,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
  });
}

function enumFrom(row: EnumRow): EnumValue {
  return Object.freeze({
    id: row.id,
    fieldId: row.fieldId,
    value: row.value,
    label: row.label,
    description: row.description ?? undefined,
    displayOrder: row.displayOrder,
  });
}

function fieldFrom(row: FieldRow, enums: readonly EnumRow[]): FieldDef {
  const enumValues = enums
    .map(enumFrom)
    .sort((a, b) => a.displayOrder - b.displayOrder);
  return Object.freeze({
    id: row.id,
    nodeId: row.nodeId,
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
    canonical: row.canonical,
    observationCount: row.observationCount,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
    enumValues: Object.freeze(enumValues),
  });
}

export class TaxonomyRepo {
  async getRoot(): Promise<TaxonomyNode> {
    const row = await db.query.taxonomyNodes.findFirst({
      where: isNull(taxonomyNodes.parentId),
    });
    if (!row) {
      throw new Error(
        "TaxonomyRepo.getRoot: no root taxonomy node found. Run seed-taxonomy.",
      );
    }
    return nodeFrom(row);
  }

  async getNode(id: number): Promise<TaxonomyNode | null> {
    const row = await db.query.taxonomyNodes.findFirst({
      where: eq(taxonomyNodes.id, id),
    });
    return row ? nodeFrom(row) : null;
  }

  async getNodeBySlugPath(
    slugs: ReadonlyArray<string>,
  ): Promise<TaxonomyNode | null> {
    let current: TaxonomyNode | null = await this.getRoot();
    if (slugs.length === 0) return current;
    for (const slug of slugs) {
      if (!current) return null;
      const row = await db.query.taxonomyNodes.findFirst({
        where: and(
          eq(taxonomyNodes.parentId, current.id),
          eq(taxonomyNodes.slug, slug),
        ),
      });
      if (!row) return null;
      current = nodeFrom(row);
    }
    return current;
  }

  async getChildren(
    parentId: number,
    opts?: { includeTentative?: boolean },
  ): Promise<ReadonlyArray<TaxonomyNode>> {
    const includeTentative = opts?.includeTentative ?? true;
    const rows = await db
      .select()
      .from(taxonomyNodes)
      .where(eq(taxonomyNodes.parentId, parentId))
      .orderBy(asc(taxonomyNodes.label));
    const out = rows.map(nodeFrom);
    return Object.freeze(
      includeTentative ? out : out.filter((n) => n.canonical),
    );
  }

  /** All nodes in the tree — used for global similarity checks. */
  async getAllNodes(): Promise<ReadonlyArray<TaxonomyNode>> {
    const rows = await db.select().from(taxonomyNodes).orderBy(asc(taxonomyNodes.id));
    return Object.freeze(rows.map(nodeFrom));
  }

  async getPath(nodeId: number): Promise<ReadonlyArray<TaxonomyNode>> {
    const path: TaxonomyNode[] = [];
    let current: TaxonomyNode | null = await this.getNode(nodeId);
    while (current) {
      path.unshift(current);
      if (current.parentId === null) break;
      current = await this.getNode(current.parentId);
    }
    return Object.freeze(path);
  }

  async getFieldsForNode(nodeId: number): Promise<ReadonlyArray<FieldDef>> {
    const rows = await db
      .select()
      .from(taxonomyNodeFields)
      .where(eq(taxonomyNodeFields.nodeId, nodeId))
      .orderBy(
        asc(taxonomyNodeFields.displayPriority),
        asc(taxonomyNodeFields.id),
      );
    if (!rows.length) return Object.freeze([]);
    const fieldIds = rows.map((r) => r.id);
    const enumRows = await db
      .select()
      .from(taxonomyNodeFieldEnumValues)
      .where(
        sql`${taxonomyNodeFieldEnumValues.fieldId} IN (${sql.join(
          fieldIds.map((id) => sql`${id}`),
          sql`, `,
        )})`,
      );
    const byField = new Map<number, EnumRow[]>();
    for (const e of enumRows) {
      const list = byField.get(e.fieldId) ?? [];
      list.push(e);
      byField.set(e.fieldId, list);
    }
    return Object.freeze(rows.map((r) => fieldFrom(r, byField.get(r.id) ?? [])));
  }

  /**
   * Accumulate fields along the path from root to node. Deepest-wins (child
   * replaces parent) for duplicate keys. Enum values for a given field key are
   * resolved from the deepest node on the path that defines enum values for
   * that key — so `set_name` defined at Trading Card picks up Pokemon's enum
   * values if the product is at Pokemon, or MTG's if at MTG.
   */
  async getAccumulatedSchema(nodeId: number): Promise<AccumulatedSchema> {
    const path = await this.getPath(nodeId);

    // Collect fields from each node (deepest last), plus a per-key map of
    // enum values by depth.
    const byKey = new Map<string, FieldDef>();
    // For each key, record the deepest node (by depth index) that supplies
    // enum values for that key.
    const enumByKey = new Map<string, ReadonlyArray<EnumValue>>();

    for (let depth = 0; depth < path.length; depth++) {
      const node = path[depth];
      const fields = await this.getFieldsForNode(node.id);
      for (const f of fields) {
        byKey.set(f.key, f); // child replaces parent
        if (f.enumValues.length > 0) {
          enumByKey.set(f.key, f.enumValues);
        }
      }
    }

    // Merge resolved enum values into the winning field.
    const fields: FieldDef[] = [];
    for (const f of byKey.values()) {
      const resolvedEnum = enumByKey.get(f.key);
      if (resolvedEnum && resolvedEnum !== f.enumValues) {
        fields.push(Object.freeze({ ...f, enumValues: resolvedEnum }));
      } else {
        fields.push(f);
      }
    }
    fields.sort((a, b) => a.displayPriority - b.displayPriority || a.id - b.id);

    return Object.freeze({
      path,
      fields: Object.freeze(fields),
    });
  }

  async incrementObservation(nodeId: number): Promise<void> {
    const now = new Date().toISOString();
    await db
      .update(taxonomyNodes)
      .set({
        observationCount: sql`${taxonomyNodes.observationCount} + 1`,
        lastObservedAt: now,
      })
      .where(eq(taxonomyNodes.id, nodeId));
  }

  async incrementFieldObservation(fieldId: number): Promise<void> {
    await db
      .update(taxonomyNodeFields)
      .set({
        observationCount: sql`${taxonomyNodeFields.observationCount} + 1`,
      })
      .where(eq(taxonomyNodeFields.id, fieldId));
  }

  async createNode(
    params: CreateNodeParams,
    triggeredBy: string,
  ): Promise<TaxonomyNode> {
    const now = new Date().toISOString();

    let pathCache: string;
    if (params.parentId === null) {
      pathCache = "/" + params.slug;
    } else {
      const parent = await this.getNode(params.parentId);
      if (!parent) {
        throw new Error(
          `TaxonomyRepo.createNode: parent ${params.parentId} not found`,
        );
      }
      pathCache =
        parent.pathCache === "/root"
          ? "/" + params.slug
          : `${parent.pathCache}/${params.slug}`;
    }

    const [row] = await db
      .insert(taxonomyNodes)
      .values({
        parentId: params.parentId,
        slug: params.slug,
        label: params.label,
        description: params.description,
        gptId: params.gptId,
        pathCache,
        canonical: params.canonical ?? false,
        observationCount: 0,
        createdAt: now,
        createdBy: triggeredBy,
      })
      .returning();

    await this.recordSchemaEvent({
      eventType: "node_created",
      nodeId: row.id,
      payload: { slug: row.slug, label: row.label, pathCache: row.pathCache },
      triggeredBy,
    });

    return nodeFrom(row);
  }

  async createField(
    params: CreateFieldParams,
    triggeredBy: string,
  ): Promise<FieldDef> {
    const now = new Date().toISOString();
    const [row] = await db
      .insert(taxonomyNodeFields)
      .values({
        nodeId: params.nodeId,
        key: params.key,
        label: params.label,
        dataType: params.dataType,
        pattern: params.pattern,
        minValue: params.minValue,
        maxValue: params.maxValue,
        isInteger: params.isInteger ?? false,
        format: params.format,
        unit: params.unit,
        extractHint: params.extractHint,
        isRequired: params.isRequired ?? false,
        isSearchable: params.isSearchable ?? false,
        searchWeight: params.searchWeight ?? 1,
        isIdentifier: params.isIdentifier ?? false,
        isPricingAxis: params.isPricingAxis ?? false,
        displayPriority: params.displayPriority ?? 100,
        isHidden: params.isHidden ?? false,
        canonical: params.canonical ?? false,
        observationCount: 0,
        createdAt: now,
        createdBy: triggeredBy,
      })
      .returning();

    await this.recordSchemaEvent({
      eventType: "field_added",
      nodeId: params.nodeId,
      fieldId: row.id,
      payload: {
        key: row.key,
        label: row.label,
        dataType: row.dataType,
      },
      triggeredBy,
    });

    return fieldFrom(row, []);
  }

  async addEnumValue(
    fieldId: number,
    value: string,
    label: string,
    displayOrder?: number,
    description?: string,
  ): Promise<EnumValue> {
    const [row] = await db
      .insert(taxonomyNodeFieldEnumValues)
      .values({
        fieldId,
        value,
        label,
        description,
        displayOrder: displayOrder ?? 100,
      })
      .onConflictDoNothing()
      .returning();

    if (row) return enumFrom(row);
    // If conflict, fetch existing
    const existing = await db.query.taxonomyNodeFieldEnumValues.findFirst({
      where: and(
        eq(taxonomyNodeFieldEnumValues.fieldId, fieldId),
        eq(taxonomyNodeFieldEnumValues.value, value),
      ),
    });
    if (!existing) {
      throw new Error(
        `TaxonomyRepo.addEnumValue: could not insert or find ${fieldId}/${value}`,
      );
    }
    return enumFrom(existing);
  }

  async promoteNode(nodeId: number, triggeredBy = "system"): Promise<void> {
    await db
      .update(taxonomyNodes)
      .set({ canonical: true })
      .where(eq(taxonomyNodes.id, nodeId));
    await this.recordSchemaEvent({
      eventType: "node_promoted",
      nodeId,
      payload: {},
      triggeredBy,
    });
  }

  async promoteField(fieldId: number, triggeredBy = "system"): Promise<void> {
    const row = await db.query.taxonomyNodeFields.findFirst({
      where: eq(taxonomyNodeFields.id, fieldId),
    });
    await db
      .update(taxonomyNodeFields)
      .set({ canonical: true })
      .where(eq(taxonomyNodeFields.id, fieldId));
    await this.recordSchemaEvent({
      eventType: "field_promoted",
      nodeId: row?.nodeId ?? null,
      fieldId,
      payload: {},
      triggeredBy,
    });
  }

  async getCurrentSchemaVersion(): Promise<number> {
    const rows = await db
      .select({ id: schemaVersions.id })
      .from(schemaVersions)
      .orderBy(desc(schemaVersions.id))
      .limit(1);
    return rows[0]?.id ?? 0;
  }

  async recordSchemaEvent(params: {
    readonly eventType: string;
    readonly nodeId?: number | null;
    readonly fieldId?: number | null;
    readonly payload: Record<string, unknown>;
    readonly triggeredBy: string;
  }): Promise<number> {
    const now = new Date().toISOString();
    const [row] = await db
      .insert(schemaVersions)
      .values({
        eventType: params.eventType,
        nodeId: params.nodeId ?? null,
        fieldId: params.fieldId ?? null,
        payload: params.payload,
        triggeredBy: params.triggeredBy,
        createdAt: now,
      })
      .returning({ id: schemaVersions.id });
    return row.id;
  }

  /**
   * Run a set of taxonomy mutations inside a single Postgres transaction.
   * Drizzle's pg driver exposes `db.transaction(async tx => ...)`.
   */
  async runInTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return db.transaction(async () => await fn());
  }
}

export const taxonomyRepo = new TaxonomyRepo();
