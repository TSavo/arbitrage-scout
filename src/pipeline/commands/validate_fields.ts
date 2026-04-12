/**
 * validateFields — coerce + validate extracted values against the accumulated
 * taxonomy schema for a leaf node.
 *
 * Rules (derived from TaxonomyRepo.FieldDef):
 *   - Coerce to dataType (string|number|boolean). If coercion fails → invalid.
 *   - Respect isInteger (for numbers), min_value/max_value, pattern (regex on
 *     stringified value), enum values (exact match).
 *   - Fields absent from schema are dropped (unconstrained extract catches
 *     everything; schema defines what's kept).
 *   - Required fields missing from extracted → missingRequired (not invalid).
 */

import type {
  AccumulatedSchema,
  FieldDef,
} from "@/db/repos/TaxonomyRepo";

export type FieldValue = string | number | boolean;

export interface ValidatedFields {
  readonly values: ReadonlyMap<string, FieldValue>;
  readonly invalid: ReadonlyArray<{
    readonly key: string;
    readonly reason: string;
  }>;
  readonly missingRequired: ReadonlyArray<string>;
}

export interface ValidateFieldsInput {
  readonly extracted: Readonly<Record<string, unknown>>;
  readonly schema: AccumulatedSchema;
}

export function validateFields(input: ValidateFieldsInput): ValidatedFields {
  const values = new Map<string, FieldValue>();
  const invalid: Array<{ key: string; reason: string }> = [];
  const missingRequired: string[] = [];

  for (const field of input.schema.fields) {
    const raw = input.extracted[field.key];
    if (raw === undefined || raw === null || raw === "") {
      if (field.isRequired) missingRequired.push(field.key);
      continue;
    }

    const coerced = coerce(raw, field);
    if (coerced.ok) {
      values.set(field.key, coerced.value);
    } else {
      invalid.push({ key: field.key, reason: coerced.reason });
    }
  }

  return Object.freeze({
    values: values as ReadonlyMap<string, FieldValue>,
    invalid: Object.freeze([...invalid]),
    missingRequired: Object.freeze([...missingRequired]),
  });
}

type CoerceResult =
  | { readonly ok: true; readonly value: FieldValue }
  | { readonly ok: false; readonly reason: string };

function coerce(raw: unknown, field: FieldDef): CoerceResult {
  switch (field.dataType) {
    case "string":
      return coerceString(raw, field);
    case "number":
      return coerceNumber(raw, field);
    case "boolean":
      return coerceBoolean(raw);
  }
}

function coerceString(raw: unknown, field: FieldDef): CoerceResult {
  let value: string;
  if (typeof raw === "string") value = raw;
  else if (typeof raw === "number" || typeof raw === "boolean") value = String(raw);
  else return { ok: false, reason: `not stringifiable: ${typeof raw}` };

  value = value.trim();
  if (!value) return { ok: false, reason: "empty string" };

  if (field.pattern) {
    try {
      const re = new RegExp(field.pattern);
      if (!re.test(value)) {
        return { ok: false, reason: `pattern mismatch: ${field.pattern}` };
      }
    } catch {
      // Invalid regex — ignore constraint.
    }
  }

  if (field.enumValues.length > 0) {
    const allowed = new Set(field.enumValues.map((e) => e.value.toLowerCase()));
    if (!allowed.has(value.toLowerCase())) {
      return {
        ok: false,
        reason: `not in enum: ${field.enumValues.map((e) => e.value).join(",")}`,
      };
    }
    // Normalize case to canonical enum value
    const canonical = field.enumValues.find(
      (e) => e.value.toLowerCase() === value.toLowerCase(),
    );
    if (canonical) value = canonical.value;
  }

  return { ok: true, value };
}

function coerceNumber(raw: unknown, field: FieldDef): CoerceResult {
  let value: number;
  if (typeof raw === "number") value = raw;
  else if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return { ok: false, reason: "empty string" };
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      return { ok: false, reason: `not numeric: "${trimmed}"` };
    }
    value = parsed;
  } else if (typeof raw === "boolean") value = raw ? 1 : 0;
  else return { ok: false, reason: `not a number: ${typeof raw}` };

  if (!Number.isFinite(value)) {
    return { ok: false, reason: "non-finite number" };
  }
  if (field.isInteger && !Number.isInteger(value)) {
    return { ok: false, reason: "not an integer" };
  }
  if (field.minValue !== undefined && value < field.minValue) {
    return { ok: false, reason: `below min ${field.minValue}` };
  }
  if (field.maxValue !== undefined && value > field.maxValue) {
    return { ok: false, reason: `above max ${field.maxValue}` };
  }

  return { ok: true, value };
}

function coerceBoolean(raw: unknown): CoerceResult {
  if (typeof raw === "boolean") return { ok: true, value: raw };
  if (typeof raw === "number") return { ok: true, value: raw !== 0 };
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (["true", "1", "yes", "y"].includes(s)) return { ok: true, value: true };
    if (["false", "0", "no", "n"].includes(s)) return { ok: true, value: false };
    return { ok: false, reason: `not boolean-ish: "${raw}"` };
  }
  return { ok: false, reason: `not boolean: ${typeof raw}` };
}
