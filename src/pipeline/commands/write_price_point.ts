/**
 * writePricePoint — record a price observation for a product.
 *
 * Pricing axes are pulled from the accumulated schema: any FieldDef with
 * isPricingAxis=true whose value is present in `fields` becomes a dimension.
 *
 * The legacy `condition` column is still written (NOT NULL constraint).
 */

import { db } from "@/db/client";
import { pricePoints } from "@/db/schema";
import type { AccumulatedSchema } from "@/db/repos/TaxonomyRepo";
import type { FieldValue } from "./validate_fields";

export interface WritePricePointInput {
  readonly productId: string;
  readonly source: string;
  readonly priceUsd: number;
  readonly fields: ReadonlyMap<string, FieldValue>;
  readonly schema: AccumulatedSchema;
  readonly recordedAt?: string;
}

export interface WritePricePointResult {
  readonly inserted: boolean;
  readonly dimensions: Readonly<Record<string, unknown>>;
}

export async function writePricePoint(
  input: WritePricePointInput,
): Promise<WritePricePointResult> {
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const dimensions = extractDimensions(input.fields, input.schema);
  const condition =
    typeof dimensions.condition === "string" ? dimensions.condition : "";

  if (!Number.isFinite(input.priceUsd) || input.priceUsd <= 0) {
    return Object.freeze({
      inserted: false,
      dimensions: Object.freeze({ ...dimensions }),
    });
  }

  try {
    await db
      .insert(pricePoints)
      .values({
        productId: input.productId,
        source: input.source,
        condition,
        dimensions,
        priceUsd: input.priceUsd,
        recordedAt,
      })
      .onConflictDoNothing();
    return Object.freeze({
      inserted: true,
      dimensions: Object.freeze({ ...dimensions }),
    });
  } catch {
    return Object.freeze({
      inserted: false,
      dimensions: Object.freeze({ ...dimensions }),
    });
  }
}

function extractDimensions(
  fields: ReadonlyMap<string, FieldValue>,
  schema: AccumulatedSchema,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema.fields) {
    if (!f.isPricingAxis) continue;
    const v = fields.get(f.key);
    if (v === undefined) continue;
    out[f.key] = v;
  }
  return out;
}
