# Taxonomy Walk + Schema Growth

Design doc for the DB-driven, self-growing product taxonomy.

## Core insight

Product types are not a fixed list. They are a **hierarchy the LLM maintains by observing listings**. The pipeline descends the tree one level at a time, classifying at each step, and the tree grows when the LLM sees something that doesn't fit.

The schema for any product is the **accumulated fields along the path from root to its leaf**. Adding a new vertical (bourbon, wine, mezcal) is an insert at the right depth. No code change.

## Non-goals

- We do NOT pre-build an exhaustive taxonomy. We seed from Google Product Taxonomy for the upper branches and let the LLM grow the leaves as listings arrive.
- We do NOT require humans to approve taxonomy growth. The LLM is authoritative (with safeguards).
- We do NOT hardcode product types, conditions, pricing axes, or identifier fields anywhere in code. Everything is read from the DB.

---

## Schema

### `taxonomy_nodes`

Replaces `product_types`. A flat table representing a tree.

```sql
CREATE TABLE taxonomy_nodes (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id       INTEGER REFERENCES taxonomy_nodes(id),
  slug            TEXT NOT NULL,              -- "bourbon", "bookers"
  label           TEXT NOT NULL,              -- "Bourbon", "Booker's"
  description     TEXT,
  gpt_id          TEXT,                       -- Google Product Taxonomy ID if mapped
  path_cache      TEXT NOT NULL,              -- denormalized "/beverages/alcoholic/spirits/whiskey/bourbon/bookers"

  -- Growth tracking
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL,              -- "seed" | "llm" | operator id
  canonical       INTEGER NOT NULL DEFAULT 0, -- 0 = tentative, 1 = accepted
  observation_count INTEGER NOT NULL DEFAULT 0, -- how many listings have matched here
  last_observed_at TEXT,

  UNIQUE(parent_id, slug)
);
CREATE INDEX ix_taxonomy_parent ON taxonomy_nodes(parent_id);
CREATE INDEX ix_taxonomy_path ON taxonomy_nodes(path_cache);
CREATE INDEX ix_taxonomy_canonical ON taxonomy_nodes(canonical);
```

A node is **tentative** until it has been observed `N` times (frequency gate — proposed default `N=3`). Tentative nodes participate in classification but are flagged and can be merged or promoted. Canonical nodes are the ones the system treats as stable.

The root has `parent_id = NULL`. There is exactly one row with `parent_id = NULL` (slug: `root`).

### `taxonomy_node_fields`

Replaces `product_type_fields`. Fields attach to a node and are **inherited by all descendants**.

```sql
CREATE TABLE taxonomy_node_fields (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id           INTEGER NOT NULL REFERENCES taxonomy_nodes(id) ON DELETE CASCADE,
  key               TEXT NOT NULL,
  label             TEXT NOT NULL,
  data_type         TEXT NOT NULL,            -- "string" | "number" | "boolean"

  pattern           TEXT,
  min_value         REAL,
  max_value         REAL,
  is_integer        INTEGER NOT NULL DEFAULT 0,

  format            TEXT,
  unit              TEXT,
  extract_hint      TEXT,

  is_required       INTEGER NOT NULL DEFAULT 0,
  is_searchable     INTEGER NOT NULL DEFAULT 0,
  search_weight     REAL NOT NULL DEFAULT 1.0,
  is_identifier     INTEGER NOT NULL DEFAULT 0,
  is_pricing_axis   INTEGER NOT NULL DEFAULT 0,
  display_priority  INTEGER NOT NULL DEFAULT 100,
  is_hidden         INTEGER NOT NULL DEFAULT 0,

  canonical         INTEGER NOT NULL DEFAULT 0,
  observation_count INTEGER NOT NULL DEFAULT 0,

  created_at        TEXT NOT NULL,
  created_by        TEXT NOT NULL,

  UNIQUE(node_id, key)
);
```

**Inheritance resolution**: a product at node `X` has the union of `taxonomy_node_fields` for all ancestors of `X` including `X` itself. If two levels define the same `key`, the deeper level wins (child overrides parent).

### `taxonomy_node_field_enum_values`

Enum values scoped to a field. Already structurally the same as the current table; rename for consistency.

```sql
CREATE TABLE taxonomy_node_field_enum_values (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  field_id      INTEGER NOT NULL REFERENCES taxonomy_node_fields(id) ON DELETE CASCADE,
  value         TEXT NOT NULL,
  label         TEXT NOT NULL,
  description   TEXT,
  display_order INTEGER NOT NULL DEFAULT 100,
  UNIQUE(field_id, value)
);
```

### `products` — minor change

```sql
ALTER TABLE products ADD COLUMN taxonomy_node_id INTEGER REFERENCES taxonomy_nodes(id);
-- product_type_id stays for back-compat during migration, dropped in a later pass
```

`products.metadata` (already a JSON column) is validated against the node's accumulated schema.

### `schema_versions`

Every schema-meaningful mutation is an event row, so we can replay and audit.

```sql
CREATE TABLE schema_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type  TEXT NOT NULL,  -- "node_created" | "node_promoted" | "field_added" | "field_promoted" | "node_merged"
  node_id     INTEGER REFERENCES taxonomy_nodes(id),
  field_id    INTEGER REFERENCES taxonomy_node_fields(id),
  payload     TEXT NOT NULL,  -- JSON describing the mutation
  triggered_by TEXT NOT NULL, -- "llm" | "seed" | listing id
  created_at  TEXT NOT NULL
);
```

Products record their `extracted_at_schema_version` so we can detect stale extractions when a node's schema evolves.

### `products` extraction watermark

```sql
ALTER TABLE products ADD COLUMN extracted_schema_version INTEGER REFERENCES schema_versions(id);
```

Used by the reprocessing worker to decide which products need re-extraction after schema growth.

---

## The walk

```
input: extracted_fields: Record<string, unknown>   // from Phase 1 (unconstrained extract)
output: path: TaxonomyNode[]  // root → leaf
        growth_events: GrowthEvent[]
```

### Algorithm

```
node = root
path = [root]
while true:
  children = getChildren(node)  // canonical + tentative
  decision = llmClassifyChildren({
    extracted: extracted_fields,
    parent: node,
    children: children,
    inheritedSchema: accumulatedFieldsFor(path),
  })

  switch decision.type:
    case "match":
      node = children.find(decision.child_id)
      path.push(node)
      incrementObservation(node)
      if isLeafForThisProduct(node, decision): break

    case "match_with_augmentation":
      node = children.find(decision.child_id)
      path.push(node)
      for field in decision.proposed_fields:
        addOrPromoteField(node, field)
      if isLeafForThisProduct(node, decision): break

    case "new_child":
      newNode = createTentativeNode(parent=node, proposal=decision.proposal)
      path.push(newNode)
      for field in decision.proposal.fields:
        createTentativeField(newNode, field)
      // new nodes are always leaf for the first listing
      break

    case "not_applicable":
      // LLM says this branch is wrong. Back up.
      if node == root: throw ClassificationFailed
      path.pop()
      node = path[-1]
      continue

    case "done":
      break
```

### The LLM prompt at each step

```
You are classifying a product listing within a taxonomy.

Current position: <path_cache of current node>
Parent node: <label + description>
Inherited schema so far: <flattened fields + enum values>

Children of this node:
- <slug>: <label> — <description> — fields added: <fields>
- ...

Extracted fields from the listing:
<JSON>

Your job: pick the correct child, or say "new_child" with a proposed slug/label/description/fields, or say "not_applicable" if this listing doesn't belong in this branch at all.

Respond with JSON:
{
  "type": "match" | "match_with_augmentation" | "new_child" | "not_applicable" | "done",
  ...
}
```

The LLM sees at most **siblings at one depth** plus the inherited schema. Never the whole tree.

### Termination

A walk terminates at:
- A node the LLM marks `done` (no further granularity needed).
- A node with no children (leaf).
- A newly created node (new nodes terminate the walk — they become the leaf).
- Max depth reached (safety, default 10 levels).

### Hot path caching

For known products, we cache the path against the product identifier. First time Booker's 2026-01 goes through, the walk takes 6+ LLM calls. Second time, we look up the previous path, validate with **one** LLM confirmation call against the leaf ("is this still Booker's 2026-01?"), and skip the descent.

Cache key: `(canonical_identifier_hash, marketplace_listing_fingerprint)`. Invalidation: any schema change to nodes on the cached path.

---

## Growth gates

### Tentative → canonical

A new node/field starts as `canonical = 0`. It's promoted when:

1. **Frequency gate**: observed on ≥ `N` distinct listings (default N=3).
2. **Similarity check**: the node isn't trivially redundant with an existing sibling. Compare: its proposed label, description, and fields against siblings via embedding. If `cosine similarity ≥ 0.95` with any sibling, auto-merge instead of promote.
3. **Stability check**: the LLM, given the new node's definition vs a re-proposed version, classifies consistent listings to the same node on a retry pass.

Promotion sets `canonical = 1` and logs a `node_promoted` event in `schema_versions`.

### Field augmentation

When the LLM proposes adding a field to an existing node (e.g., `batch_code` on Bourbon), the same gates apply at field level. Field proposals are recorded, observation-counted, and promoted independently. A tentative field is still extracted/stored for matching products, but not considered a schema requirement until promoted.

### Merges

If similarity check flags two nodes as near-duplicates (`≥ 0.95`), the system proposes a merge. The merge combines field sets, re-parents child nodes and products, and logs the event. Merges also require frequency: a merge isn't performed on a single-observation tentative node — tentative nodes that are near-duplicates are auto-redirected to the canonical sibling without a merge event.

### Conflict resolution

- Two LLM calls disagree about which sibling this is → keep as tentative, increment observation on both candidates, next call tiebreaks.
- LLM proposes a new node that overlaps an existing tentative node → route to the existing tentative, reinforce it.
- Schema drift (same product keeps getting classified to different paths) → lock the node's schema for 24 hours, log event for review.

---

## Concurrency

Taxonomy mutations are serialized. Options:

1. **Single writer**: all pipeline instances enqueue taxonomy-mutating events to a work queue; one worker applies them. Pipeline continues with the unmutated schema and picks up changes on its next listing.
2. **Advisory lock**: use `BEGIN IMMEDIATE` transactions around mutations. Short-lived, acceptable for SQLite.

We go with option 2 for simplicity — SQLite's `BEGIN IMMEDIATE` is an exclusive write lock that other writers wait on. Pipeline operations are already serialized per listing; the mutation block is milliseconds.

Within a transaction:

```
BEGIN IMMEDIATE;
  INSERT INTO taxonomy_nodes (...) ON CONFLICT DO NOTHING;
  INSERT INTO taxonomy_node_fields (...);
  INSERT INTO schema_versions (...);
COMMIT;
```

Idempotent via unique constraints. Two listings proposing the same new node race harmlessly: first wins, second sees the row already exists and reinforces it.

---

## Reprocessing

When a node's schema grows after products are already classified there, those products may need re-extraction. A background job:

1. Reads `schema_versions` for recent `field_added` / `field_promoted` events.
2. Queries products where `taxonomy_node_id` is on the affected path AND `extracted_schema_version < event.id`.
3. Re-runs extraction (using the current schema), validate, identity resolution. If identity resolution now splits one product into many (e.g., Booker's 2026-01 and 2026-02 were collapsed), performs the split: creates new products, re-parents listing_items, keeps price_points with the correct new product.
4. Updates `extracted_schema_version` to mark completion.

The reprocessing worker is separate from the hot pipeline. Always async. Rate-limited to avoid hammering Ollama.

---

## Pipeline integration

The walk is Phase 2. Full pipeline ordering:

### Phase 1 — Unconstrained extract

LLM reads raw listing text. Returns flat `Record<string, unknown>`. No target schema. Goal: capture everything the text asserts as structured key-values.

### Phase 2 — Classify (the walk)

Descend the taxonomy using the extracted dict. Output: a `path` of nodes and any `GrowthEvent`s applied.

### Phase 3 — Schema resolution

Accumulate fields along the path. Resulting schema is a `FieldDef[]` with identifier, pricing-axis, searchable flags.

### Phase 4 — Validate & coerce

Walk the extracted dict against the accumulated schema. Apply `data_type` coercion, validate constraints. Drop fields not in schema or coerce-and-flag.

### Phase 5 — Identity resolution

Given the validated fields and the schema's `is_identifier` fields:

1. External identifier match (SKU, UPC, etc. in `product_identifiers`).
2. Canonical field match on the product's taxonomy node (all identifier fields equal).
3. Embedding similarity within the same taxonomy node (top-k, threshold).
4. No match → new product.

### Phase 6 — Persist

Product row (if new). Listing row. Listing_item link. Embedding for the listing text. Set `extracted_schema_version`.

### Phase 7 — Price

Extract pricing-axis values from validated fields → `dimensions` JSON. Write `price_points` row.

### Phase 8 — Evaluate

Compare listing price to market (aggregate of recent price_points with matching dimensions for this product). Produce opportunities if profit threshold met.

### Phase 9 — Emit

Event bus: `listing.classified`, `product.created`, `opportunity.found`, `taxonomy.grew`, etc. SSE forwards. Watchlist checks.

---

## Immutability

All types in the pipeline are `readonly`. Each phase takes an immutable input and returns a new immutable value. The pipeline orchestrator threads values through, never mutates.

```typescript
interface ExtractedFields { readonly [key: string]: unknown }
interface TaxonomyPath { readonly nodes: readonly TaxonomyNode[] }
interface ResolvedSchema { readonly fields: readonly FieldDef[] }
interface ValidatedFields { readonly values: ReadonlyMap<string, FieldValue>, readonly invalid: readonly string[] }
interface ResolvedIdentity { readonly productId: string, readonly isNew: boolean }
interface StoredProduct { readonly id: string, readonly listingItemId: number }
// ...
```

The only mutations happen at persistence boundaries (DB writes), and those happen inside transactions.

---

## What this replaces

- `product_types` (rename + extend to hierarchy)
- `product_type_fields` (rename + attach to nodes)
- `product_type_field_enum_values` (rename)
- The hardcoded keyword map in `extract.ts`
- The hardcoded condition hint in `confirm.ts`
- The hardcoded pricing logic that assumes `condition` is a universal axis
- Any downstream code that enumerates product types in switches or conditionals

---

## Migration

1. Add new tables, keep old ones.
2. Seed: copy `product_types` rows into `taxonomy_nodes` as children of a new `root`. Copy `product_type_fields` into `taxonomy_node_fields`. Mark all as `canonical=1`.
3. For every existing product, set `taxonomy_node_id` to the new node, copy `condition_schema`/`metadata_schema` values into the new structure.
4. Update pipeline to read from new tables.
5. Validate: re-run tests, check that classifications match expected nodes.
6. Drop old tables.

---

## Open questions

- **Root children**: do we mirror Google Product Taxonomy at top levels, or ours? Proposal: mirror GPT for the top 2–3 levels (Beverages, Collectibles, Electronics, etc.), then the LLM grows below.
- **Inheritance override**: when a child field has the same key as a parent field, does it completely replace, or merge constraints? Proposal: completely replace — the child is the authority.
- **Scoped enum values**: MTG set_name and Pokemon set_name share a field key but have different valid values. Do we: (a) have separate fields at each game's node, (b) share the field at a Trading Card node but have the enum values live at the game-specific child node? Proposal: (b). Enum values can live at any node that refines a parent's field.
- **Multiple parents**: can a node have multiple parents? (A "1990s Pokemon card" is both "Pokemon" and "1990s collectible.") Proposal: no — single-parent tree. Cross-cutting concerns are separate tags, not taxonomy parents.
- **Versioning granularity**: do we track schema version at the node level or the whole-taxonomy level? Proposal: whole-taxonomy (event log in `schema_versions`). Any node on a product's path changing invalidates its watermark.
