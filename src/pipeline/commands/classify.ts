/**
 * classify — the taxonomy walk.
 *
 * Given a listing and extracted fields, descend the taxonomy one level at a
 * time. At each level the LLM is shown:
 *   - the parent node (label + description),
 *   - the inherited schema (accumulated ancestor fields),
 *   - the current set of canonical + tentative children with their own fields,
 *   - the extracted fields + raw listing text.
 *
 * The LLM returns a decision — match / match_with_augmentation / new_child /
 * not_applicable / done. We apply the decision (via SchemaGrowthService for
 * growth events) and either descend, back up, or terminate.
 *
 * Max depth 10, as a safety rail.
 */

import {
  taxonomyRepo,
  type TaxonomyNode,
  type AccumulatedSchema,
  type FieldDef,
} from "@/db/repos/TaxonomyRepo";
import {
  SchemaGrowthService,
  schemaGrowthService,
  type ProposedField,
} from "../schema_growth";
import type { RawListing } from "../types";
import type { LlmClient } from "./confirm";

const MAX_DEPTH = 10;

export interface ClassifyInput {
  readonly listing: RawListing;
  readonly extractedFields: Readonly<Record<string, unknown>>;
  readonly llmClient?: LlmClient;
  readonly growthService?: SchemaGrowthService;
}

export type GrowthEventType =
  | "node_created"
  | "node_reinforced"
  | "field_added"
  | "field_reinforced";

export interface GrowthEvent {
  readonly type: GrowthEventType;
  readonly nodeId: number;
  readonly fieldId?: number;
  readonly detail: string;
}

export interface ClassifyResult {
  readonly path: ReadonlyArray<TaxonomyNode>;
  readonly accumulatedSchema: AccumulatedSchema;
  readonly growthEvents: ReadonlyArray<GrowthEvent>;
  readonly usedLlm: boolean;
}

type WalkDecision =
  | { readonly type: "match"; readonly slug: string }
  | {
      readonly type: "match_with_augmentation";
      readonly slug: string;
      readonly new_fields?: ReadonlyArray<ProposedField>;
    }
  | {
      readonly type: "new_child";
      readonly proposal: {
        readonly slug: string;
        readonly label: string;
        readonly description: string;
        readonly fields?: ReadonlyArray<ProposedField>;
      };
    }
  | { readonly type: "not_applicable" }
  | { readonly type: "done" };

export async function classify(input: ClassifyInput): Promise<ClassifyResult> {
  const growth = input.growthService ?? schemaGrowthService;
  const events: GrowthEvent[] = [];

  const root = await taxonomyRepo.getRoot();
  const path: TaxonomyNode[] = [root];
  let usedLlm = false;

  // A listing at root gets incremented too — root is the universal ancestor.
  await taxonomyRepo.incrementObservation(root.id);

  const triggeredBy = `listing:${input.listing.marketplaceId}:${input.listing.listingId}`;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const current = path[path.length - 1];
    const children = await taxonomyRepo.getChildren(current.id);
    const inherited = await taxonomyRepo.getAccumulatedSchema(current.id);

    // If no LLM is available, we cannot descend; we classify at the current
    // level and stop. This is the rule-based fallback path.
    if (!input.llmClient) {
      break;
    }

    usedLlm = true;

    const prompt = buildClassifyPrompt({
      listing: input.listing,
      extracted: input.extractedFields,
      current,
      inherited,
      children,
    });

    let decision: WalkDecision;
    try {
      const raw = await input.llmClient.generateJson(prompt, {
        system: CLASSIFY_SYSTEM,
      });
      decision = coerceDecision(raw);
    } catch {
      // LLM failure → stop here; the current path is our best guess.
      break;
    }

    if (decision.type === "done") break;

    if (decision.type === "not_applicable") {
      // Back up one level. Never pop root.
      if (path.length <= 1) break;
      path.pop();
      continue;
    }

    if (decision.type === "match" || decision.type === "match_with_augmentation") {
      const child = findChild(children, decision.slug);
      if (!child) {
        // Bad slug — treat as done to avoid a loop.
        break;
      }

      path.push(child);
      await taxonomyRepo.incrementObservation(child.id);

      if (decision.type === "match_with_augmentation" && decision.new_fields) {
        for (const nf of decision.new_fields) {
          const res = await growth.proposeField({
            nodeId: child.id,
            field: nf,
            triggeredBy,
          });
          events.push({
            type: res.created ? "field_added" : "field_reinforced",
            nodeId: child.id,
            fieldId: res.fieldId,
            detail: nf.key,
          });
        }
      }
      continue;
    }

    if (decision.type === "new_child") {
      const res = await growth.proposeChildNode({
        parentId: current.id,
        slug: decision.proposal.slug,
        label: decision.proposal.label,
        description: decision.proposal.description,
        fields: decision.proposal.fields ?? [],
        triggeredBy,
      });
      const createdNode = await taxonomyRepo.getNode(res.nodeId);
      if (!createdNode) break;
      path.push(createdNode);
      events.push({
        type: res.created ? "node_created" : "node_reinforced",
        nodeId: createdNode.id,
        detail: createdNode.slug,
      });
      // New or reinforced node terminates this walk — first listing becomes
      // the leaf for this path.
      break;
    }
  }

  const leaf = path[path.length - 1];
  const accumulated = await taxonomyRepo.getAccumulatedSchema(leaf.id);

  return Object.freeze({
    path: Object.freeze([...path]),
    accumulatedSchema: accumulated,
    growthEvents: Object.freeze(events),
    usedLlm,
  });
}

const CLASSIFY_SYSTEM = `You are classifying a product listing within a hierarchical taxonomy of product categories. You descend the tree one level at a time. At each step you pick the best matching child, propose a new child if none fit, ask to back up if the branch is wrong, or say "done" when no further granularity is needed. Reply with JSON only.`;

function buildClassifyPrompt(args: {
  readonly listing: RawListing;
  readonly extracted: Readonly<Record<string, unknown>>;
  readonly current: TaxonomyNode;
  readonly inherited: AccumulatedSchema;
  readonly children: ReadonlyArray<TaxonomyNode>;
}): string {
  const { listing, extracted, current, inherited, children } = args;

  const inheritedLines =
    inherited.fields.length === 0
      ? "(none)"
      : inherited.fields.map(formatField).join("\n");

  const childLines =
    children.length === 0
      ? "No children yet at this level."
      : children
          .map((c, i) => {
            return `${i + 1}. ${c.slug}: ${c.label} — ${c.description ?? "(no description)"}${
              c.canonical ? "" : " [tentative]"
            }`;
          })
          .join("\n");

  return [
    `CURRENT PATH: ${current.pathCache}`,
    `PARENT: ${current.label} — ${current.description ?? "(no description)"}`,
    "",
    "INHERITED SCHEMA (fields already required by ancestors):",
    inheritedLines,
    "",
    `CHILDREN OF ${current.slug}:`,
    childLines,
    "",
    "EXTRACTED LISTING FIELDS:",
    JSON.stringify(extracted, null, 2),
    "",
    "RAW LISTING TEXT:",
    `Title: ${listing.title}`,
    listing.description ? `Description: ${listing.description}` : "",
    "",
    "Your task: classify this listing.",
    '- If it matches one of the existing children, respond with {"type":"match","slug":"<slug>"}',
    '- If it matches a child but evidence suggests a new field should be added at that child, respond with {"type":"match_with_augmentation","slug":"<slug>","new_fields":[{"key":"...","label":"...","dataType":"string|number|boolean"}]}',
    '- If none of the children fit and a new sibling is warranted, respond with {"type":"new_child","proposal":{"slug":"<slug>","label":"<label>","description":"<desc>","fields":[...]}}',
    '- If this listing does not belong in this branch (misclassified from parent), respond with {"type":"not_applicable"}',
    '- If no further granularity is needed, respond with {"type":"done"}',
    "",
    "Respond with JSON only.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatField(f: FieldDef): string {
  const flags: string[] = [];
  if (f.isRequired) flags.push("required");
  if (f.isIdentifier) flags.push("identifier");
  if (f.isPricingAxis) flags.push("pricing-axis");
  const flagStr = flags.length ? ` [${flags.join(", ")}]` : "";
  const unit = f.unit ? ` ${f.unit}` : "";
  const enumStr = f.enumValues.length
    ? ` (values: ${f.enumValues.map((e) => e.value).join(", ")})`
    : "";
  return `  - ${f.key} (${f.dataType}${unit}): ${f.label}${flagStr}${enumStr}`;
}

function findChild(
  children: ReadonlyArray<TaxonomyNode>,
  slug: string,
): TaxonomyNode | undefined {
  const s = slug.toLowerCase();
  return children.find((c) => c.slug.toLowerCase() === s);
}

function coerceDecision(raw: unknown): WalkDecision {
  if (!raw || typeof raw !== "object") return { type: "done" };
  const obj = raw as Record<string, unknown>;
  const t = obj.type;
  if (t === "match" && typeof obj.slug === "string") {
    return { type: "match", slug: obj.slug };
  }
  if (t === "match_with_augmentation" && typeof obj.slug === "string") {
    return {
      type: "match_with_augmentation",
      slug: obj.slug,
      new_fields: coerceFields(obj.new_fields),
    };
  }
  if (t === "new_child" && obj.proposal && typeof obj.proposal === "object") {
    const p = obj.proposal as Record<string, unknown>;
    if (
      typeof p.slug === "string" &&
      typeof p.label === "string" &&
      typeof p.description === "string"
    ) {
      return {
        type: "new_child",
        proposal: {
          slug: p.slug,
          label: p.label,
          description: p.description,
          fields: coerceFields(p.fields),
        },
      };
    }
  }
  if (t === "not_applicable") return { type: "not_applicable" };
  return { type: "done" };
}

function coerceFields(raw: unknown): ReadonlyArray<ProposedField> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: ProposedField[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const f = r as Record<string, unknown>;
    if (typeof f.key !== "string" || typeof f.label !== "string") continue;
    const dt = f.dataType;
    if (dt !== "string" && dt !== "number" && dt !== "boolean") continue;
    out.push({
      key: f.key,
      label: f.label,
      dataType: dt,
      pattern: typeof f.pattern === "string" ? f.pattern : undefined,
      minValue: typeof f.minValue === "number" ? f.minValue : undefined,
      maxValue: typeof f.maxValue === "number" ? f.maxValue : undefined,
      isInteger: f.isInteger === true,
      unit: typeof f.unit === "string" ? f.unit : undefined,
      extractHint:
        typeof f.extractHint === "string" ? f.extractHint : undefined,
      isRequired: f.isRequired === true,
      isSearchable: f.isSearchable === true,
      searchWeight:
        typeof f.searchWeight === "number" ? f.searchWeight : undefined,
      isIdentifier: f.isIdentifier === true,
      isPricingAxis: f.isPricingAxis === true,
      displayPriority:
        typeof f.displayPriority === "number" ? f.displayPriority : undefined,
      isHidden: f.isHidden === true,
    });
  }
  return Object.freeze(out);
}
