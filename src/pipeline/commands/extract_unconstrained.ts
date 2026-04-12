/**
 * Unconstrained extract — Phase 1 of the new taxonomy pipeline.
 *
 * Unlike the legacy extract (which takes a target schema and tries to fill
 * in predefined fields), this one extracts whatever structured facts the
 * listing asserts. No target schema, no filtering, no hardcoded keyword
 * table. Output is a flat Record<string, unknown>.
 *
 * LLM path:   prompt the model for "extract all structured key-value facts
 *             from this listing, return flat JSON".
 * Fallback:   rule-based text-pattern extraction — numbers + years/age,
 *             dollar amounts, set/card-number-looking tokens, etc.
 */

import type { RawListing } from "../types";
import type { LlmClient } from "./confirm";

export interface UnconstrainedExtractInput {
  readonly listing: RawListing;
  readonly llmClient?: LlmClient;
}

export interface UnconstrainedExtractResult {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly confidence: number;
  readonly extractedAt: number;
  readonly usedLlm: boolean;
}

const EXTRACT_SYSTEM = `You are a structured-data extractor for marketplace product listings. Your job: read the listing text and return every structured key-value fact it asserts. Do not guess, do not invent fields, do not fill in unknowns — only extract what the text actually states. Output flat JSON only.`;

const EXTRACT_PROMPT_TEMPLATE = `## Listing

{context}

## Task

Extract every structured key-value fact asserted by this listing. Return a flat JSON object of primitive values (strings, numbers, booleans).

Rules:
- Use snake_case keys (e.g. "set_name", "card_number", "release_year").
- Do not include commentary keys — just the data the text states.
- Do not guess or fill in unknowns. If the listing does not say it, omit the key.
- If the listing is a lot of N items, include "item_count": N.
- Capture pricing-relevant attributes when stated (condition, grade, grading_company, etc.).

Return JSON only — no prose, no code fences.`;

export async function extractUnconstrained(
  input: UnconstrainedExtractInput,
): Promise<UnconstrainedExtractResult> {
  if (input.llmClient) {
    try {
      const context = formatContext(input.listing);
      const raw = await input.llmClient.generateJson(
        EXTRACT_PROMPT_TEMPLATE.replace("{context}", context),
        { system: EXTRACT_SYSTEM },
      );
      const fields = coerceFlatObject(raw);
      return Object.freeze({
        fields: Object.freeze(fields),
        confidence: Object.keys(fields).length > 0 ? 0.7 : 0,
        extractedAt: Date.now(),
        usedLlm: true,
      });
    } catch {
      // fall through to rule-based
    }
  }
  return ruleBasedUnconstrainedExtract(input);
}

export function ruleBasedUnconstrainedExtract(
  input: UnconstrainedExtractInput,
): UnconstrainedExtractResult {
  const { listing } = input;
  const text = [
    listing.title,
    listing.description ?? "",
    listing.conditionRaw ?? "",
    listing.categoryRaw ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  const lower = text.toLowerCase();

  const out: Record<string, unknown> = {};

  // Age / years — "12 yr", "18 year", "23 year old"
  const ageMatch = lower.match(/\b(\d{1,3})\s*(?:yr|year)s?\b/);
  if (ageMatch) {
    const n = Number(ageMatch[1]);
    if (Number.isFinite(n) && n > 0 && n < 200) out.age = n;
  }

  // Year — 4-digit year, 1900..2099
  const yearMatch = text.match(/\b(19\d{2}|20\d{2})\b/);
  if (yearMatch) out.year = Number(yearMatch[1]);

  // Prices / proof — numbers in text
  const priceMatch = text.match(/\$\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  if (priceMatch) out.stated_price_usd = Number(priceMatch[1]);

  // Proof (bourbon etc.) — "90 proof"
  const proofMatch = lower.match(/\b(\d{2,3})\s*proof\b/);
  if (proofMatch) out.proof = Number(proofMatch[1]);

  // Set / card-number pattern — "020/189"
  const cardNumMatch = text.match(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/);
  if (cardNumMatch) out.card_number = `${cardNumMatch[1]}/${cardNumMatch[2]}`;

  // Grading + grade — "PSA 10", "BGS 9.5", "CGC 9.8"
  const gradeMatch = text.match(/\b(PSA|BGS|CGC|SGC|CBCS|PCGS|NGC)\s*(\d+(?:\.\d+)?)\b/i);
  if (gradeMatch) {
    out.grading_company = gradeMatch[1].toUpperCase();
    const g = Number(gradeMatch[2]);
    if (Number.isFinite(g)) out.grade = g;
  }

  // Conditions (unconstrained — emit raw keywords if seen)
  const condHints = [
    ["sealed", "sealed"],
    ["new in box", "new_in_box"],
    ["cib", "cib"],
    ["complete in box", "cib"],
    ["loose", "loose"],
    ["disc only", "loose"],
    ["near mint", "near_mint"],
    ["mint", "mint"],
    ["lightly played", "lightly_played"],
    ["untested", "untested"],
    ["as-is", "as_is"],
    ["for parts", "for_parts"],
  ] as const;
  for (const [needle, value] of condHints) {
    if (lower.includes(needle)) {
      out.condition_raw ??= value;
    }
  }

  // Lot count
  if (listing.itemCount && listing.itemCount > 1) {
    out.item_count = listing.itemCount;
  } else {
    const lotMatch = lower.match(/\blot of\s+(\d+)\b/);
    if (lotMatch) out.item_count = Number(lotMatch[1]);
  }

  // Propagate explicit metadata from the listing itself
  if (listing.conditionRaw) out.condition_stated = listing.conditionRaw;
  if (listing.categoryRaw) out.category_stated = listing.categoryRaw;

  // Title becomes a canonical anchor for downstream steps
  out.title = listing.title;

  return Object.freeze({
    fields: Object.freeze(out),
    confidence: Object.keys(out).length > 1 ? 0.4 : 0.2,
    extractedAt: Date.now(),
    usedLlm: false,
  });
}

function formatContext(listing: RawListing): string {
  const lines: string[] = [];
  lines.push(`Marketplace: ${listing.marketplaceId}`);
  lines.push(`Title: "${listing.title}"`);
  if (listing.description) lines.push(`Description: "${listing.description}"`);
  if (listing.conditionRaw) lines.push(`Condition: ${listing.conditionRaw}`);
  if (listing.categoryRaw) lines.push(`Category: ${listing.categoryRaw}`);
  if (listing.itemCount && listing.itemCount > 1) {
    lines.push(`Lot of ${listing.itemCount}`);
  }
  lines.push(
    `Price: $${listing.priceUsd.toFixed(2)}${
      listing.shippingUsd ? ` + $${listing.shippingUsd.toFixed(2)} ship` : ""
    }`,
  );
  return lines.join("\n");
}

function coerceFlatObject(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (v === null || v === undefined) continue;
    if (
      typeof v === "string" ||
      typeof v === "number" ||
      typeof v === "boolean"
    ) {
      out[k] = v;
    } else if (Array.isArray(v)) {
      // Flatten simple arrays to CSV strings; skip arrays of objects.
      const prim = v.every(
        (x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean",
      );
      if (prim) out[k] = v.join(", ");
    } else {
      // Nested objects become JSON strings so information isn't lost.
      try {
        out[k] = JSON.stringify(v);
      } catch {
        /* skip */
      }
    }
  }
  return out;
}
