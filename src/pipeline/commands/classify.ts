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

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { taxonomyExternalRefs } from "@/db/schema";
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
import type { LlmClient } from "@/llm/pool";
import { log, error } from "@/lib/logger";

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

/**
 * Category-hint fastPath. If the listing carries a category from its
 * adapter (Shopify product_type in categoryRaw, eBay categoryId in
 * extra.ebay_category_id, PriceCharting category in extra.pc_category),
 * consult taxonomy_external_refs for a pre-mapped node. Returns the
 * target node if found — classify() then builds the path via getPath and
 * skips the LLM walk entirely.
 *
 * Confidence ≥ 0.9 only. Lower-confidence refs (root-rollups from the
 * backfill) land at the wrong depth and would hurt accuracy.
 */
async function fastPathByHint(
  input: ClassifyInput,
): Promise<{ nodeId: number; source: string; externalId: string } | null> {
  const lookups: Array<{ source: string; externalId: string }> = [];

  // Shopify adapters put product_type in category_raw. eBay adapters too.
  if (input.listing.categoryRaw) {
    const slug = input.listing.categoryRaw
      .toLowerCase().replace(/[&,'’"]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    if (slug) {
      lookups.push({ source: "shopify_product_type", externalId: slug });
    }
  }

  const extra = (input.listing.extra ?? {}) as Record<string, unknown>;
  const ebayId = extra.ebay_category_id ?? extra.ebayCategoryId;
  if (typeof ebayId === "string" || typeof ebayId === "number") {
    lookups.push({ source: "ebay_us", externalId: String(ebayId) });
  }
  const pcCat = extra.pc_category ?? extra.priceCharting_category;
  if (typeof pcCat === "string") {
    lookups.push({ source: "pricecharting", externalId: pcCat });
  }

  for (const { source, externalId } of lookups) {
    const row = await db.query.taxonomyExternalRefs.findFirst({
      where: and(
        eq(taxonomyExternalRefs.source, source),
        eq(taxonomyExternalRefs.externalId, externalId),
      ),
      columns: { nodeId: true, confidence: true },
      orderBy: [desc(taxonomyExternalRefs.confidence)],
    });
    if (row && row.confidence >= 0.9) {
      return { nodeId: row.nodeId, source, externalId };
    }
  }
  return null;
}

export async function classify(input: ClassifyInput): Promise<ClassifyResult> {
  const growth = input.growthService ?? schemaGrowthService;
  const events: GrowthEvent[] = [];

  // Category-hint fastPath — skip the LLM walk entirely when the listing
  // carries a known category we've mapped in taxonomy_external_refs.
  const hint = await fastPathByHint(input);
  if (hint) {
    const pathNodes = await taxonomyRepo.getPath(hint.nodeId);
    const leaf = pathNodes[pathNodes.length - 1];
    await taxonomyRepo.incrementObservation(leaf.id);
    const accumulated = await taxonomyRepo.getAccumulatedSchema(leaf.id);
    log(
      "classify",
      `hint fastPath: ${hint.source}="${hint.externalId}" → ${leaf.pathCache}`,
    );
    return Object.freeze({
      path: Object.freeze(pathNodes),
      accumulatedSchema: accumulated,
      growthEvents: Object.freeze([] as GrowthEvent[]),
      usedLlm: false,
    });
  }

  const root = await taxonomyRepo.getRoot();
  const path: TaxonomyNode[] = [root];
  let usedLlm = false;
  // keep inArray reference bound for any downstream drizzle usage
  void inArray;

  // A listing at root gets incremented too — root is the universal ancestor.
  await taxonomyRepo.incrementObservation(root.id);

  const triggeredBy = `listing:${input.listing.marketplaceId}:${input.listing.listingId}`;

  // Per-walk memory of children the LLM has already rejected at each parent.
  // Without this, popping back to a single-child parent re-offers the only
  // child in an infinite loop until MAX_DEPTH.
  const rejected = new Map<number, Set<string>>();

  // Cap consecutive pops. One pop is a healthy "we picked the wrong child,
  // back up and try another sibling" correction. Multiple in a row means
  // the walk is cascading up the tree — each pop rejects an ancestor, which
  // eventually starves the LLM of correct options and forces it to invent
  // parallel branches. After this many consecutive not_applicables without
  // an intervening successful match, we force `done` at the current node.
  const MAX_CONSECUTIVE_POPS = 2;
  let consecutivePops = 0;

  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const current = path[path.length - 1];
    const allChildren = await taxonomyRepo.getChildren(current.id);
    const rejSet = rejected.get(current.id);
    const children = rejSet
      ? allChildren.filter((c) => !rejSet.has(c.slug))
      : allChildren;
    const inherited = await taxonomyRepo.getAccumulatedSchema(current.id);

    // If no LLM is available, we cannot descend; we classify at the current
    // level and stop. This is the rule-based fallback path.
    if (!input.llmClient) {
      break;
    }

    usedLlm = true;

    // NOTE: we do NOT break on allChildren.length === 0. A leaf still needs
    // the LLM to confirm fit — if the current leaf is the wrong leaf, it
    // should return `not_applicable` so we back up, and at the parent the
    // rejected-children memory will steer the LLM toward `new_child`
    // (a new sibling of the wrong leaf).
    if (allChildren.length === 0) {
      log("classify", `depth=${depth} at "${current.slug}" is a leaf — asking LLM to confirm fit`);
    }
    // If every canonical child at this node has been rejected already, don't
    // re-offer them — ask the LLM only to propose a new branch or give up.

    const prompt = buildClassifyPrompt({
      listing: input.listing,
      extracted: input.extractedFields,
      current,
      inherited,
      children,
      rejectedSiblings: rejSet ? Array.from(rejSet) : [],
    });

    let decision: WalkDecision;
    let raw: unknown;
    try {
      raw = await input.llmClient.generateJson(prompt, {
        system: CLASSIFY_SYSTEM,
      });
      decision = coerceDecision(raw);
      log("classify", `depth=${depth} at "${current.slug}" (${children.length} children): decision=${decision.type}${decision.type === "match" || decision.type === "match_with_augmentation" ? ` slug="${decision.slug}"` : decision.type === "new_child" ? ` new_slug="${decision.proposal.slug}"` : ""}`);
    } catch (err) {
      error("classify", `depth=${depth} LLM call failed at "${current.slug}": ${err instanceof Error ? err.message : String(err)}`);
      break;
    }

    if (decision.type === "done") {
      log("classify", `depth=${depth} done at "${current.slug}"`);
      break;
    }

    if (decision.type === "not_applicable") {
      // Hit the pop cap? Treat this as "we've done our best, stop here."
      // Prevents the cascade where each successive pop corrupts an ancestor.
      if (consecutivePops >= MAX_CONSECUTIVE_POPS) {
        log(
          "classify",
          `depth=${depth} consecutive pops capped (${consecutivePops}) at "${current.slug}" — forcing done`,
        );
        break;
      }
      // Back up one level. Never pop root. Remember that whatever child led
      // here is not applicable, so we don't reconsider it at this parent.
      if (path.length <= 1) break;
      const rejectedChild = path.pop()!;
      const parent = path[path.length - 1];
      const set = rejected.get(parent.id) ?? new Set<string>();
      set.add(rejectedChild.slug);
      rejected.set(parent.id, set);
      consecutivePops++;
      continue;
    }

    if (decision.type === "match" || decision.type === "match_with_augmentation") {
      const child = findChild(children, decision.slug);
      if (!child) {
        // Bad slug — treat as done to avoid a loop.
        break;
      }
      // Healthy forward progress — reset the pop counter.
      consecutivePops = 0;

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

      // If schema_growth redirected the proposal to an existing node elsewhere
      // in the tree (reinforced=true and the node's real parent isn't our
      // current node), the listing truly belongs at that node's location —
      // rebuild the walk path to reflect the node's actual ancestry instead
      // of pretending it's a child of `current`.
      if (res.reinforced && createdNode.parentId !== current.id) {
        const truePath = await taxonomyRepo.getPath(createdNode.id);
        path.length = 0;
        path.push(...truePath);
        log(
          "classify",
          `depth=${depth} new_child "${decision.proposal.slug}" redirected to existing node "${createdNode.slug}" at "${truePath.map((n) => n.slug).join(" → ")}"`,
        );
      } else {
        path.push(createdNode);
      }
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

const CLASSIFY_SYSTEM = `You are a domain expert helping organize a taxonomy of collectible and consumer secondary-market products. The platform deals with wines, spirits, beers, trading cards, video games, comics, coins, watches, figures, sporting goods, memorabilia — any kind of secondary-market good. You know how collectors and markets actually segment each of these domains and can reason about any category you encounter.

Your job: walk down the taxonomy one level at a time. At each level you reason about where a given listing belongs: match an existing child, grow the taxonomy with a genuinely missing category, back up if we're in the wrong branch, or stop if the current node is already the right home.

The taxonomy exists to group PRICING COMPARABLES. Two products under the same leaf should be fungible enough that their price histories are informative about each other's value. Every category boundary should be one the market itself recognizes — the boundaries you'd use when BROWSING inventory, not when filtering within it.

───────────────────────────────────────────────────────────────
DESCEND THROUGH THE EXISTING STRUCTURE
───────────────────────────────────────────────────────────────

The taxonomy's upper levels are intentionally broad — they mirror general product categorization schemes. A wine bottle lives many levels deep (food & beverages → beverages → alcoholic beverages → wine → red wine → region → varietal). A retro video game lives deep (electronics → video games → physical game media → console → title).

When you're at a high-level node and the listing doesn't seem to match anything "at this level," that's the WRONG signal. The right question is: which broad existing child contains the narrower category this listing belongs to, many levels down? A single-malt scotch at the top level isn't a mismatch for "food_beverages_tobacco" — it belongs under that broad bucket because everything edible/drinkable does. Descend through the existing hierarchy rather than inventing a parallel shortcut tree.

Never create a new_child at a high level that duplicates structure already present deeper. If a category already exists somewhere deeper in the tree, do not propose it as a direct child of the root or of a broad top-level category. Descend through the real path.

Propose new_child only when:
  - You've descended to the level where the missing category genuinely belongs (same depth as its siblings), and
  - No sibling at that level captures it.

If you're not sure whether an existing child branch contains what you need, MATCH into the broader-looking one and descend — you can correct course on the next step.

Read the listing title for explicit category names. Product titles usually contain the category outright (e.g. the title says "bourbon", "pinot noir", "vintage ale", "rookie card"). If an existing child matches a word or phrase in the title, descend into it — don't stop at a broader parent out of over-caution. Conversely, don't let attribute clutter (batch codes, year, proof, condition) prevent you from recognizing the category the title actually names.

───────────────────────────────────────────────────────────────
THE CORE CONCEPT — CATEGORY vs ATTRIBUTE
───────────────────────────────────────────────────────────────

A CATEGORY is a KIND of product. It answers: "what IS this thing, as the market identifies it?" Categories define identity. They're the labels you use to BROWSE inventory: "show me items in this category." Many distinct products share a category and are pricing comparables within it.

An ATTRIBUTE is a PROPERTY of a specific unit. It answers: "what is true about THIS particular item?" Attributes let you FILTER within a category — age, condition, grade, size, edition, batch, release year, finishing method, edition number, any quantified or qualified property of a single item. Attributes differentiate units within the same category but do not define a kind on their own.

The test to apply to any candidate new_child:
  - Would you BROWSE to it ("show me all X")?  → category, maybe valid
  - Would you FILTER by it within another category?  → attribute, not a category
  - Could hundreds of distinct products share this as their primary identity?  → category
  - Does it describe a specific release, grading, condition, size, batch, or variation of an otherwise-identical product?  → attribute

Attributes belong on the product row as extracted FIELDS (captured by the extractor stage). They MUST NOT appear as taxonomy children.

Generic red flags that a proposed new_child is actually an attribute:
  - The slug contains a year, number, grade value, ABV, size, or other quantity.
  - The slug describes a release type, edition flag, finishing process, grading status, or condition adjective.
  - The "category" would span multiple existing unrelated categories (e.g. applying to both whiskey AND beer AND wine — that's a cross-cutting attribute, not a parent category).
  - Your own reasoning keeps reaching for "this is a KIND of X within Y" and you can't name the kind independent of the attribute.

When you're tempted to propose a new_child, ask yourself in plain language: "Is this a KIND of product people organize inventory by, or a PROPERTY people filter by within an existing kind?" If you can't confidently say it's a kind, return done — the extractor will capture the detail as a field.

───────────────────────────────────────────────────────────────
Use your judgment. Different domains segment differently — wines by region/varietal/vintage-style, spirits by origin/process/style, trading cards by set/series/era, video games by platform/generation, comics by publisher/title/era. Reason from first principles about how collectors would browse, not from keyword patterns.

Do not force a near-miss match. A wrong classification poisons downstream pricing far more than an honest new_child for a genuinely missing category, or not_applicable to back up.

Respond with JSON only — no prose, no <think> blocks.`;

function buildClassifyPrompt(args: {
  readonly listing: RawListing;
  readonly extracted: Readonly<Record<string, unknown>>;
  readonly current: TaxonomyNode;
  readonly inherited: AccumulatedSchema;
  readonly children: ReadonlyArray<TaxonomyNode>;
  readonly rejectedSiblings?: ReadonlyArray<string>;
}): string {
  const { listing, extracted, current, inherited, children, rejectedSiblings } = args;

  const inheritedLines =
    inherited.fields.length === 0
      ? "(none)"
      : inherited.fields.map(formatField).join("\n");

  const rejectedNote =
    rejectedSiblings && rejectedSiblings.length
      ? `\n\nALREADY REJECTED at this node (do NOT re-offer): ${rejectedSiblings.join(", ")}`
      : "";

  const childLines =
    children.length === 0
      ? "This node currently has no children. Strongly prefer `done` here — the leaf is already the right home for the listing. Only propose `new_child` if you're confident the listing represents a KIND of product at this level that many distinct products across different producers / releases / specific items would also fit into (e.g. at `whiskey` node with no children yet, proposing `bourbon` would be valid because thousands of distinct bourbons exist). Do NOT create a new_child for a specific release, edition, batch, series name, grading, condition, or attribute of an individual bottle/card/unit. Return `not_applicable` only if this leaf is truly the wrong category entirely." + rejectedNote
      : children
          .map((c, i) => {
            return `${i + 1}. ${c.slug}: ${c.label} — ${c.description ?? "(no description)"}${
              c.canonical ? "" : " [tentative]"
            }`;
          })
          .join("\n");

  return [
    `We're walking down a product taxonomy, currently at: ${current.pathCache}`,
    "",
    `Current node — "${current.label}": ${current.description ?? "(no description provided)"}`,
    "",
    "Schema inherited from ancestors (every product under this subtree carries these fields):",
    inheritedLines,
    "",
    `Existing children of "${current.slug}":`,
    childLines,
    "",
    "Extracted fields the extractor pulled from the listing:",
    JSON.stringify(extracted, null, 2),
    "",
    "Listing:",
    `  Title: ${listing.title}`,
    listing.description ? `  Description: ${listing.description}` : "",
    "",
    "Reason about this listing using your domain knowledge. What kind of product is it? Does the current node's meaning actually cover it? Does any existing child precisely describe it, or is there a genuine category missing at this level?",
    "",
    "Four valid outcomes (pick the one that reflects your actual judgment):",
    "",
    "  MATCH — an existing child clearly fits. Descend through it.",
    "  NEW_CHILD — the listing's kind genuinely belongs under this node but no existing child captures it. Propose one. Remember: the new node must be a KIND (category), not a PROPERTY (attribute). If you can't name it as a thing collectors would browse to, it's an attribute and doesn't belong in the taxonomy — return done instead.",
    "  NOT_APPLICABLE — we're in the wrong part of the tree (whether via a wrong branch higher up, or by descending into a specific child that turned out not to match). Backing up is the right move.",
    "  DONE — this node is the correct precise home for the listing and further subdivision would be artificial.",
    "",
    "Never force a near-miss match. A wrong classification poisons downstream pricing.",
    "",
    "Response options (JSON, no prose):",
    '- {"type":"match","slug":"<slug>"} — descend through this existing child',
    '- {"type":"match_with_augmentation","slug":"<slug>","new_fields":[{"key":"...","label":"...","dataType":"string|number|boolean"}]} — descend AND add a field the child needs',
    '- {"type":"new_child","proposal":{"slug":"<slug>","label":"<label>","description":"<desc>","fields":[...]}} — listing is semantically distinct from every existing child here; grow the taxonomy',
    '- {"type":"not_applicable"} — this listing does not belong in this branch; back up',
    '- {"type":"done"} — classification is specific enough; stop descending',
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
