/**
 * resolveIdentity — match a listing to a product row (or decide to create a
 * new product).
 *
 * Attempt order:
 *   1. External identifier (product_identifiers) from listing.extra
 *   2. Canonical-field match: all identifier fields with values in `fields`
 *      must equal the candidate product's metadata — within the same
 *      taxonomy node.
 *   3. Embedding similarity within the same taxonomy node
 *      (top-k via EmbeddingRepo, with a threshold).
 *   4. Otherwise → new product (caller handles insertion).
 *
 * This phase is pure lookup + decision. It does NOT mutate the DB.
 * The caller (persist) performs any inserts/updates.
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { products, productIdentifiers } from "@/db/schema";
import { embeddingRepo } from "@/db/repos/EmbeddingRepo";
import type {
  AccumulatedSchema,
  FieldDef,
  TaxonomyNode,
} from "@/db/repos/TaxonomyRepo";
import type { ValidatedListing } from "../types";
import type { FieldValue } from "./validate_fields";
import { generateId } from "../utils";

export type IdentityMethod =
  | "external_id"
  | "canonical_fields"
  | "embedding"
  | "new";

export interface IdentityResolution {
  readonly productId: string;
  readonly isNew: boolean;
  readonly method: IdentityMethod;
  /** Title used to seed a new product (title we'd insert if isNew). */
  readonly title: string;
}

export interface ResolveIdentityInput {
  readonly listing: ValidatedListing;
  readonly fields: ReadonlyMap<string, FieldValue>;
  readonly node: TaxonomyNode;
  readonly schema: AccumulatedSchema;
  readonly embeddingThreshold?: number;
  readonly ollamaUrl?: string;
}

const EXTERNAL_ID_KEYS: ReadonlyArray<readonly [string, string]> = Object.freeze([
  ["pc_product_id", "pricecharting"],
  ["discogs_id", "discogs"],
  ["tcgplayer_id", "tcgplayer"],
  ["mercari_id", "mercari"],
  ["upc", "upc"],
  ["asin", "asin"],
  ["epid", "ebay_epid"],
  ["isbn", "isbn"],
  ["mpn", "mpn"],
]);

export async function resolveIdentity(
  input: ResolveIdentityInput,
): Promise<IdentityResolution> {
  const titleFromFields = stringField(input.fields, [
    "name",
    "title",
    "product_name",
  ]);
  const title = titleFromFields ?? input.listing.title;
  // 0.95 is intentionally aggressive — 0.88 catastrophically collapsed 731
  // distinct listings (Pappy, Van Winkle, Bardstown Fusion, Willett) into
  // a single "Jack Daniel's Tanyard Hill" anchor product. Ollama qwen3
  // embeddings put any two bourbons too close together to rely on loose
  // similarity alone; must pair with brand-agreement gate below.
  const threshold = input.embeddingThreshold ?? 0.95;

  // 1 — External identifier from extra.
  const extra = input.listing.extra ?? {};
  for (const [key, type] of EXTERNAL_ID_KEYS) {
    const v = extra[key];
    if (v === undefined || v === null) continue;
    const value = typeof v === "string" ? v.trim() : String(v).trim();
    if (!value) continue;

    const hit = await db.query.productIdentifiers.findFirst({
      where: and(
        eq(productIdentifiers.identifierType, type),
        eq(productIdentifiers.identifierValue, value),
      ),
      columns: { productId: true },
    });
    if (hit) {
      return Object.freeze({
        productId: hit.productId,
        isNew: false,
        method: "external_id" as const,
        title,
      });
    }
  }

  // 2 — Canonical-field match within the same node.
  const identifierFields: FieldDef[] = input.schema.fields.filter(
    (f) => f.isIdentifier,
  );
  const identifierValues: Array<readonly [string, FieldValue]> = [];
  for (const f of identifierFields) {
    const v = input.fields.get(f.key);
    if (v !== undefined) identifierValues.push([f.key, v]);
  }

  if (identifierValues.length > 0) {
    const matches = await queryProductsByMetadata(
      input.node.id,
      identifierValues,
    );
    if (matches.length === 1) {
      return Object.freeze({
        productId: matches[0].id,
        isNew: false,
        method: "canonical_fields" as const,
        title,
      });
    }
    // Multiple matches — ambiguous; fall through to embedding to break tie.
  }

  // 3 — Embedding similarity within the node.
  //     Gated by brand-agreement: if the current listing extracted a brand
  //     and the candidate product's metadata has a brand, they must match
  //     (case-insensitive). This prevents the anchor-product collapse we
  //     saw where every bourbon got matched to one "Jack Daniel's
  //     Tanyard Hill" product because cosine sim stayed above 0.88.
  try {
    const queryText = buildEmbeddingText(title, input.fields);
    const vec = await embeddingRepo.getOrCompute(
      "listing",
      `resolve:${input.listing.marketplaceId}:${input.listing.listingId}`,
      queryText,
      input.ollamaUrl,
    );
    if (vec && vec.length > 0) {
      const listingBrand = stringField(input.fields, ["brand"])?.toLowerCase();
      const neighbors = await embeddingRepo.findSimilar("product", vec, 10);
      for (const n of neighbors) {
        // pgvector cosine distance: 0 identical, 2 opposite.
        const sim = 1 - n.distance;
        if (sim < threshold) continue;
        const prod = await db.query.products.findFirst({
          where: eq(products.id, n.entityId),
          columns: { id: true, taxonomyNodeId: true, metadata: true },
        });
        if (!prod) continue;
        if (prod.taxonomyNodeId !== input.node.id) continue;
        // Brand-agreement gate
        if (listingBrand) {
          const prodBrand = (prod.metadata as Record<string, unknown> | null)
            ?.["brand"];
          if (typeof prodBrand === "string" && prodBrand.toLowerCase() !== listingBrand) {
            continue;
          }
        }
        return Object.freeze({
          productId: prod.id,
          isNew: false,
          method: "embedding" as const,
          title,
        });
      }
    }
  } catch {
    // Embedding unavailable — continue to new.
  }

  // 4 — New product.
  return Object.freeze({
    productId: generateId("prod"),
    isNew: true,
    method: "new" as const,
    title,
  });
}

function stringField(
  fields: ReadonlyMap<string, FieldValue>,
  keys: readonly string[],
): string | undefined {
  for (const k of keys) {
    const v = fields.get(k);
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

async function queryProductsByMetadata(
  nodeId: number,
  kvs: ReadonlyArray<readonly [string, FieldValue]>,
): Promise<Array<{ readonly id: string }>> {
  // Postgres jsonb path lookup. ->> extracts text, -> extracts jsonb.
  // For numeric/boolean comparisons we cast the text result accordingly.
  const conds = [eq(products.taxonomyNodeId, nodeId)];
  for (const [key, value] of kvs) {
    if (typeof value === "string") {
      conds.push(sql`${products.metadata}->>${key} = ${value}`);
    } else if (typeof value === "number") {
      conds.push(sql`(${products.metadata}->>${key})::numeric = ${value}`);
    } else {
      // boolean: jsonb true/false vs textual 'true'/'false'
      conds.push(sql`${products.metadata}->>${key} = ${value ? "true" : "false"}`);
    }
  }
  const rows = await db
    .select({ id: products.id })
    .from(products)
    .where(and(...conds))
    .limit(5);
  return rows;
}

function buildEmbeddingText(
  title: string,
  fields: ReadonlyMap<string, FieldValue>,
): string {
  const parts: string[] = [title];
  for (const [k, v] of fields) {
    parts.push(`${k}: ${v}`);
  }
  return parts.join(" \u2022 ");
}
