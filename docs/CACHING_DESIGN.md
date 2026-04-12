# Caching Architecture

Caching is load-bearing, not optional. Every computation that crosses a phase boundary, hits the DB, or calls an external service goes through the cache. No exceptions.

## Cost Hierarchy (this drives everything)

| Cost | Tier | Implication |
|---|---|---|
| **CPU cycles** | free | Compute freely. JSON parsing, cosine similarity, hash lookups — don't optimize these. |
| **Disk I/O** | essentially free | Write logs, materialize aggregates, persist caches. A 1GB materialized view is a rounding error. |
| **Local DB reads/writes** | cheap | SQLite + WAL + indexes. Thousands/sec. Always prefer a DB lookup over an LLM call. |
| **Embedding call** | moderate | ~2s per call, GPU-bound on battleaxe. Cache aggressively. |
| **LLM inference** | expensive | 1–5s per call, GPU-bound. Every LLM call we skip is a real win. **This is what caching exists to avoid.** |

**The core rule**: every cache layer exists to avoid an LLM call (directly or transitively). Disk/CPU/DB work that prevents an LLM call is always worth it, even if the hit rate is modest. Contorting the system to save cheap reads is pointless; contorting the system to save LLM calls is the job.

This produces concrete heuristics:
- **Disk over memory** when invalidation is simple. Materialized views survive restarts; in-memory LRUs must warm up.
- **Fire-and-forget cache writes.** If a cache insert fails, don't fail the pipeline — the LLM result is already valuable, the cache is opportunistic.
- **Trade CPU for LLM calls aggressively.** Compute dozens of embeddings locally, scan a thousand-row table, hash a large text — all of it is free compared to one LLM call.
- **Don't cache writes or cheap enumerations.** Inserts go straight to DB. Event streams are push, not pull. The audit log is append-only — caching it is the wrong abstraction.

## Principle

**Fast path is the common path.** The pipeline is designed so that a warmed-up system does almost nothing per listing — indexed lookups, a few writes, done. Caching is what makes this true.

Without caching, the "fast path" becomes a series of redundant queries: pull the product, pull its taxonomy node, pull its accumulated schema, pull market prices, pull identifier matches. Each listing in a scan hits these same things. Caching is the difference between O(n × m) and O(n + m) where n is listings and m is per-listing work.

## Cache Layers

Every cache is typed, immutable (the values, not the cache itself), and wrapped in a `CachingService` with named caches and hit/miss metrics.

### Process-level (in-memory, cleared on restart)

| Cache | Key | Value | Invalidation |
|---|---|---|---|
| `taxonomy.nodes` | `nodeId` | `TaxonomyNode` | `taxonomy.grew` event |
| `taxonomy.children` | `parentId` | `readonly TaxonomyNode[]` | `taxonomy.grew` on parent or any child |
| `taxonomy.path` | `nodeId` | `readonly TaxonomyNode[]` (root→node) | `taxonomy.grew` on any node in path |
| `taxonomy.accumulated_schema` | `nodeId` | `AccumulatedSchema` | `taxonomy.grew` or `field.added` on path |
| `product.identifiers` | `(identifier_type, identifier_value)` | `productId` | `product.identifier.added` |
| `product.row` | `productId` | `Product` | `product.updated` |
| `product.node` | `productId` | `nodeId` | `product.updated` (reclassification) |
| `market.price` | `(productId, dimensionsHash)` | `{ median, mean, count, lastUpdatedAt }` | `price_point.inserted` for that product |
| `listing.known` | `(marketplaceId, marketplaceListingId)` | `{ listingId, productIds, tier }` | `listing.updated` on that listing |

### DB-level (durable across restarts)

| Cache | Table | Refresh trigger |
|---|---|---|
| `product_identifiers` | Already exists | Populated on product identity resolution |
| `taxonomy_classification_cache` | New — `(marketplace_id, marketplace_listing_id, product_ids, classified_at, schema_version)` | Pipeline writes on classify success; invalidated on schema_version bump for any node on path |
| `market_prices_mv` | New — materialized aggregate per `(product_id, dimensions_hash)` with count, median, mean | Refreshed by background worker on `price_point.inserted` events, batched every N seconds |

### Request-level (single scan's scope)

| Cache | Scope |
|---|---|
| Per-scan `products` cache | Map populated on first reference, valid for the scan only |
| Per-scan `nodes` cache | Same |
| Per-scan `embeddings` cache | Same |

Request-level caches sit inside the `CommandPipeline` instance, populated lazily, thrown away on scan completion. Process-level caches sit in the `CachingService` singleton.

## Invalidation via event bus

We already have `eventBus` for SSE. Extend it to be the cache invalidation channel. Mutation points emit typed events:

- `taxonomy.grew` — new node or field promoted
- `field.added` — field added to a node
- `product.identifier.added` — new identifier row
- `product.updated` — product row changed (taxonomy_node_id or metadata)
- `price_point.inserted` — new price data
- `listing.updated` — listing row changed

Caches subscribe on startup. Invalidation is push, not poll. No TTLs — entries are valid until invalidated.

This also means: the SSE subscribers we already have can watch the same events for UI updates. One event stream, many consumers.

## CachingService shape

```typescript
export interface Cache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): void;
  invalidate(predicate: (key: K, value: V) => boolean): number;
  invalidateAll(): void;
  // Metrics
  readonly hits: number;
  readonly misses: number;
  readonly size: number;
}

export class CachingService {
  readonly taxonomyNodes: Cache<number, TaxonomyNode>;
  readonly taxonomyChildren: Cache<number, ReadonlyArray<TaxonomyNode>>;
  readonly taxonomyPath: Cache<number, ReadonlyArray<TaxonomyNode>>;
  readonly accumulatedSchema: Cache<number, AccumulatedSchema>;
  readonly productIdentifiers: Cache<string, string>;  // key = `${type}:${value}`
  readonly productRows: Cache<string, Product>;
  readonly marketPrices: Cache<string, MarketPriceStat>;  // key = `${productId}:${dimensionsHash}`
  readonly listingKnown: Cache<string, KnownListing>;    // key = `${marketplaceId}:${listingId}`
  
  // Subscribe to event bus on construction
  constructor(private bus: EventBus) {
    bus.on("taxonomy.grew", (e) => this.onTaxonomyGrew(e));
    bus.on("field.added", (e) => this.onFieldAdded(e));
    bus.on("product.identifier.added", (e) => this.onIdentifierAdded(e));
    bus.on("product.updated", (e) => this.onProductUpdated(e));
    bus.on("price_point.inserted", (e) => this.onPricePointInserted(e));
    bus.on("listing.updated", (e) => this.onListingUpdated(e));
  }
  
  // Metrics
  getMetrics(): CacheMetrics;
}
```

Every cache has an LRU bound to prevent unbounded growth. Size configurable per cache based on expected cardinality (taxonomy small, products huge).

## Integration with repos

Repos don't cache internally — the CachingService is the caching layer, and repos are pass-throughs for cache misses.

```typescript
class ProductRepo {
  constructor(private cache: CachingService) {}
  
  async findById(id: string): Promise<Product | null> {
    const cached = this.cache.productRows.get(id);
    if (cached) return cached;
    
    const row = await db.query.products.findFirst({ where: eq(products.id, id) });
    if (row) this.cache.productRows.set(id, row);
    return row ?? null;
  }
}
```

This keeps repos honest: they always go through the cache. No repo method exists that bypasses caching except for explicit refresh operations.

## Metrics and observability

Every cache exposes hits/misses/size. The scan log includes per-phase cache hit rates. The dashboard gets a caching panel:

- Tier distribution (tier 1 / 2 / 3) per scan
- Cache hit rate per named cache, last hour
- Invalidation rate per event type
- Warmest products (most cache hits) — indicates hot products to pre-warm

If tier 3 exceeds some threshold (say 20% of listings), that's a signal that either adapters aren't emitting identifiers, or the classification cache isn't being written properly, or the product_identifiers table isn't capturing what it should. The metric is the canary.

## Warm-up

On pipeline startup:

1. Preload taxonomy tree into `taxonomyNodes`, `taxonomyChildren`.
2. Precompute `accumulatedSchema` for every canonical node.
3. Batch-load `product_identifiers` into `productIdentifiers`.
4. Leave products and market prices lazy — too many to preload, and hit rates will warm quickly.

Warm-up takes seconds at startup. After that, the system runs cold only on things it's never seen.

## What this replaces

- Ad-hoc caching sprinkled in individual repos (EmbeddingRepo has its own cache, ProductRepo had an implicit one)
- Per-request lookups that repeat across a scan loop
- Unmeasured performance claims ("this should be fast")

Consolidation: one caching service, one invalidation model, one metrics dashboard.

## Not cached

The only things that shouldn't cache:

- **Writes.** Every insert/update/upsert goes straight to the DB, fires invalidation events, and doesn't touch the cache directly. Reads repopulate from DB on next access.
- **The event stream itself.** SSE is push, not pull. Caching the events would be the wrong abstraction.
- **The scan log.** It's an append-only audit trail, not something we query repeatedly.

Everything else is cached without exception.

## Rollout

1. Build `CachingService` and the `Cache` interface. Unit tests.
2. Wire into `CommandPipeline` — instantiate once, pass to phases.
3. Migrate one cache at a time: taxonomy first (smallest, highest churn protection), then product identifiers, then market prices.
4. Add metrics collection. Dashboard panel.
5. Tune LRU bounds based on observed cardinality.
6. Decommission any repo-level ad-hoc caching.

Rollout is incremental but the destination is clear: every boundary caches, or we explain why.
