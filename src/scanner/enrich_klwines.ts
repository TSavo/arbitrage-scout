/**
 * enrich-klwines — walk every inventory_items row with a klwines catalog
 * SKU, fetch shop.klwines.com/products/details/:sku, parse the schema.org
 * JSON-LD, and:
 *
 *   1. Resolve or create the canonical `products` row (title + metadata
 *      + taxonomy from the JSON-LD `category` field).
 *   2. Index the klwines_sku as a product_identifier so future scans hit
 *      the Tier-1 external_id fastPath instantly.
 *   3. Backfill `inventory_items.product_id`.
 *   4. Write a price_point (current K&L retail or "last listed" for sold
 *      out) keyed on source=klwines, dimensions={availability}.
 *   5. Create a watchlist entry at +20% over purchase so the user gets
 *      alerted when the market appreciates.
 *
 * The critic review, if present in JSON-LD, is stored in product.metadata
 * as a structured blob — cheap to query, no separate reviews table yet.
 *
 * Reuses the shared headed Chrome (same session as scanner + cellar).
 * Paces requests with the usual bursty human-pause cadence.
 */

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import {
  inventoryItems,
  products,
  productIdentifiers,
  pricePoints,
  watchlistItems,
  taxonomyNodes,
} from "@/db/schema";
import { getSharedContext } from "@/lib/shared_browser";
import { log, section, skip, error as logError } from "@/lib/logger";
import type { Page } from "playwright";
import { generateId } from "@/pipeline/utils";
import { classify } from "@/pipeline/commands/classify";
import { buildDefaultPool } from "@/llm/pool";
import type { LlmClient } from "@/llm/pool";
import type { RawListing } from "@/pipeline/types";

const BASE = "https://www.klwines.com";
const ALERT_PCT = 20; // watchlist fires when current >= purchase * 1.20

function humanPause(): number {
  return Math.random() < 0.1 ? 15_000 + Math.random() * 30_000 : 5_000 + Math.random() * 6_000;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function gotoSafe(page: Page, url: string, tries = 4): Promise<void> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      return;
    } catch (err) {
      const msg = (err as Error).message;
      if (attempt < tries && /ERR_ABORTED|net::ERR|Navigation|Timeout/i.test(msg)) {
        await sleep(3_000 * attempt + Math.random() * 2_000);
        continue;
      }
      throw err;
    }
  }
}

/** Canonical JSON-LD shape we care about from /products/details/:sku. */
interface KlwinesJsonLd {
  readonly sku?: string;
  readonly name?: string;
  readonly image?: string;
  readonly category?: string;
  readonly countryOfOrigin?: string;
  readonly size?: string;
  readonly keywords?: string | string[];
  readonly description?: string;
  readonly offers?: Array<{
    readonly availability?: string;
    readonly price?: number | string;
    readonly priceCurrency?: string;
  }>;
  readonly review?: Array<{
    readonly author?: { readonly name?: string };
    readonly reviewBody?: string;
    readonly datePublished?: string | null;
  }>;
  readonly aggregateRating?: {
    readonly ratingValue?: number;
    readonly bestRating?: number;
    readonly worstRating?: number;
    readonly reviewCount?: number;
  };
}

interface ScrapedProduct {
  readonly jsonLd: KlwinesJsonLd;
  readonly alcoholContent?: string;
  readonly varietal?: string;
  readonly origin?: string;
}

async function scrapeProduct(page: Page, sku: string): Promise<ScrapedProduct | null> {
  const url = `${BASE}/products/details/${sku}`;
  await gotoSafe(page, url);
  const data = await page.evaluate(`(() => {
    // JSON-LD Product schema — the structured source of truth.
    const ldEl = document.querySelector('script[type="application/ld+json"]');
    let jsonLd = {};
    try { jsonLd = ldEl ? JSON.parse(ldEl.textContent || '{}') : {}; } catch {}
    // Details block: "Origin: ...", "Type/Varietal: ...", "Alcohol Content: ...".
    const details = {};
    const detailText = (() => {
      for (const h of document.querySelectorAll('h1,h2,h3,h4')) {
        if (/Product Details/i.test(h.textContent || '')) {
          return (h.parentElement?.textContent || '').replace(/\\s+/g, ' ').trim();
        }
      }
      return '';
    })();
    // Each field is concatenated with no separator; use explicit next-label
    // lookaheads to know where to stop. Fields: Origin, Type/Varietal,
    // Alcohol Content, SKU.
    details.origin = detailText.match(/Origin:\\s*(.+?)\\s*(?=Type\\/Varietal:|Alcohol Content:|SKU:|$)/)?.[1]?.trim();
    details.varietal = detailText.match(/Type\\/Varietal:\\s*(.+?)\\s*(?=Alcohol Content:|SKU:|Origin:|$)/)?.[1]?.trim();
    details.alcoholContent = detailText.match(/Alcohol Content:\\s*([\\d.]+\\s*%)/)?.[1]?.replace(/\\s+/g,'');
    return { jsonLd, details };
  })()`) as { jsonLd: KlwinesJsonLd; details: { origin?: string; varietal?: string; alcoholContent?: string } };
  if (!data.jsonLd || !data.jsonLd.name) return null;
  return {
    jsonLd: data.jsonLd,
    origin: data.details.origin,
    varietal: data.details.varietal,
    alcoholContent: data.details.alcoholContent,
  };
}

function offerPrice(jsonLd: KlwinesJsonLd): { price: number | null; inStock: boolean } {
  const offer = jsonLd.offers?.[0];
  if (!offer) return { price: null, inStock: false };
  const raw = offer.price;
  const price = typeof raw === "number" ? raw : raw ? parseFloat(String(raw)) : null;
  const inStock = /InStock/i.test(offer.availability ?? "");
  return { price: Number.isFinite(price!) ? price : null, inStock };
}

/**
 * Map K&L's `category` string to a taxonomy node by matching path_cache
 * suffix. Example: "Bourbon and Rye / Distilled Spirits" → search for a
 * node whose label or path_cache contains "bourbon". Best-effort; falls
 * through to null if no clean match.
 */
/**
 * Run the full LLM taxonomy walk on the scraped JSON-LD. We build a
 * synthetic RawListing from the structured fields (category + description
 * + review form a richer context than any auction title) and feed the
 * classify command, which handles the whole descent through the taxonomy
 * tree with schema growth. Returns the leaf node id.
 */
async function classifyFromJsonLd(
  sku: string,
  scraped: ScrapedProduct,
  llm: LlmClient | null,
): Promise<number | null> {
  if (!llm) return null;
  const { jsonLd } = scraped;
  // Synthesize a rich description from all the structured signals.
  const descParts: string[] = [];
  if (jsonLd.category) descParts.push(`Category: ${jsonLd.category}`);
  if (scraped.varietal) descParts.push(`Type/Varietal: ${scraped.varietal}`);
  if (scraped.origin) descParts.push(`Origin: ${scraped.origin}`);
  if (jsonLd.countryOfOrigin) descParts.push(`Country: ${jsonLd.countryOfOrigin}`);
  if (scraped.alcoholContent) descParts.push(`Alcohol: ${scraped.alcoholContent}`);
  if (jsonLd.size) descParts.push(`Size: ${jsonLd.size}`);
  if (jsonLd.description) descParts.push(`\n${jsonLd.description}`);
  const review = jsonLd.review?.[0];
  if (review?.reviewBody) descParts.push(`\nReview by ${review.author?.name ?? "critic"}: ${review.reviewBody}`);

  const listing: RawListing = Object.freeze({
    marketplaceId: "klwines",
    listingId: `enrich:${sku}`,
    title: jsonLd.name ?? "",
    description: descParts.join("\n"),
    categoryRaw: jsonLd.category,
    priceUsd: 0,
    shippingUsd: 0,
    url: `https://shop.klwines.com/products/details/${sku}`,
    scrapedAt: Date.now(),
    extra: { klwines_sku: sku },
  });
  const extractedFields: Record<string, unknown> = {};
  if (scraped.varietal) extractedFields.varietal = scraped.varietal;
  if (scraped.origin) extractedFields.origin = scraped.origin;
  if (scraped.alcoholContent) extractedFields.alcohol_content = scraped.alcoholContent;
  if (jsonLd.countryOfOrigin) extractedFields.country_of_origin = jsonLd.countryOfOrigin;
  if (jsonLd.size) extractedFields.size = jsonLd.size;
  try {
    const result = await classify({ listing, extractedFields, llmClient: llm });
    const leaf = result.path[result.path.length - 1];
    return leaf?.id ?? null;
  } catch (err) {
    logError("enrich-kl", `classify failed: ${(err as Error).message.slice(0, 100)}`);
    return null;
  }
}

// Compat shim kept for the unused `taxonomyNodes` import below. Remove when unused.
async function _noop(): Promise<void> { void taxonomyNodes; }
void _noop;

async function upsertProductFromJsonLd(
  sku: string,
  scraped: ScrapedProduct,
  llm: LlmClient | null,
): Promise<{ productId: string; isNew: boolean }> {
  // 1. Existing product via klwines_sku identifier?
  const existingId = await db.query.productIdentifiers.findFirst({
    where: and(
      eq(productIdentifiers.identifierType, "klwines_sku"),
      eq(productIdentifiers.identifierValue, sku),
    ),
    columns: { productId: true },
  });
  const now = new Date().toISOString();
  const { jsonLd } = scraped;
  const taxonomyNodeId = await classifyFromJsonLd(sku, scraped, llm);
  const metadata: Record<string, unknown> = {
    klwines_sku: sku,
    category: jsonLd.category,
    country_of_origin: jsonLd.countryOfOrigin,
    size: jsonLd.size,
    keywords: Array.isArray(jsonLd.keywords) ? jsonLd.keywords : jsonLd.keywords ? [jsonLd.keywords] : undefined,
    description: jsonLd.description,
    origin: scraped.origin,
    varietal: scraped.varietal,
    alcohol_content: scraped.alcoholContent,
    image: jsonLd.image,
    review: jsonLd.review,
    aggregateRating: jsonLd.aggregateRating,
  };
  // Strip undefined for cleanliness.
  for (const k of Object.keys(metadata)) if (metadata[k] === undefined) delete metadata[k];

  if (existingId) {
    await db
      .update(products)
      .set({
        title: jsonLd.name!,
        metadata,
        taxonomyNodeId: taxonomyNodeId ?? undefined,
        updatedAt: now,
      })
      .where(eq(products.id, existingId.productId));
    return { productId: existingId.productId, isNew: false };
  }

  const newId = generateId("prod");
  await db.insert(products).values({
    id: newId,
    title: jsonLd.name!,
    taxonomyNodeId,
    metadata,
    salesVolume: 0,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(productIdentifiers)
    .values({
      productId: newId,
      identifierType: "klwines_sku",
      identifierValue: sku,
    })
    .onConflictDoNothing();
  return { productId: newId, isNew: true };
}

async function writePrice(
  productId: string,
  price: number,
  inStock: boolean,
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  await db
    .insert(pricePoints)
    .values({
      productId,
      source: "klwines",
      condition: inStock ? "retail" : "last_listed",
      dimensions: { availability: inStock ? "InStock" : "OutOfStock", source: "klwines_catalog" },
      priceUsd: price,
      recordedAt: today,
    })
    .onConflictDoNothing();
}

async function ensureWatch(productId: string): Promise<boolean> {
  const existing = await db.query.watchlistItems.findFirst({
    where: and(eq(watchlistItems.productId, productId), eq(watchlistItems.active, true)),
    columns: { id: true },
  });
  if (existing) return false;
  await db.insert(watchlistItems).values({
    productId,
    targetPricePct: ALERT_PCT,
    condition: "retail",
    createdAt: new Date().toISOString(),
    active: true,
    notes: "auto-added by enrich-klwines",
  });
  return true;
}

export async function enrichKlwines(): Promise<{
  scanned: number;
  scraped: number;
  linked: number;
  newProducts: number;
  prices: number;
  watched: number;
  errors: number;
}> {
  section("ENRICH-KLWINES — valuing inventory from shop.klwines.com");

  const rows = await db
    .select({
      id: inventoryItems.id,
      sku: inventoryItems.sourceSku,
      title: inventoryItems.title,
      paid: inventoryItems.purchasePriceUsd,
      productId: inventoryItems.productId,
    })
    .from(inventoryItems)
    .where(
      and(
        eq(inventoryItems.source, "klwines"),
        isNotNull(inventoryItems.sourceSku),
      ),
    )
    .orderBy(sql`RANDOM()`)
    .limit(Number(process.env.ENRICH_LIMIT) || 100_000);

  log("enrich-kl", `${rows.length} inventory rows with klwines SKU`);

  let llm: LlmClient | null = null;
  try {
    llm = buildDefaultPool();
  } catch (err) {
    skip("enrich-kl", `LLM pool unavailable (${(err as Error).message}) — taxonomy classification will be skipped`);
  }

  const ctx = await getSharedContext();
  const page =
    ctx.pages().find((p) => /klwines\.com/.test(p.url())) ??
    (await ctx.newPage());
  await page.bringToFront().catch(() => {});

  let scraped = 0;
  let linked = 0;
  let newProducts = 0;
  let prices = 0;
  let watched = 0;
  let errors = 0;

  for (const [i, row] of rows.entries()) {
    log(
      "enrich-kl",
      `${i + 1}/${rows.length}: sku=${row.sku} paid=$${row.paid ?? "?"}  ${row.title.slice(0, 60)}`,
    );
    if (i > 0) await sleep(humanPause());
    try {
      const sku = row.sku!;
      const product = await scrapeProduct(page, sku);
      if (!product) {
        log("enrich-kl", `  → no JSON-LD (page may be dead)`);
        errors++;
        continue;
      }
      scraped++;
      const { productId, isNew } = await upsertProductFromJsonLd(sku, product, llm);
      if (isNew) newProducts++;
      // Link inventory row → canonical product.
      if (!row.productId) {
        await db
          .update(inventoryItems)
          .set({ productId })
          .where(eq(inventoryItems.id, row.id));
        linked++;
      }
      const { price, inStock } = offerPrice(product.jsonLd);
      if (price != null && price > 0) {
        await writePrice(productId, price, inStock);
        prices++;
      }
      if (await ensureWatch(productId)) watched++;
      const statusTag = inStock ? "InStock" : "SoldOut";
      const delta =
        price != null && row.paid != null && row.paid > 0
          ? `Δ${((price / row.paid - 1) * 100).toFixed(0)}%`
          : "";
      log(
        "enrich-kl",
        `  ✓ ${isNew ? "new" : "existing"} product  ${statusTag} $${price?.toFixed(2) ?? "?"}  ${delta}`,
      );
    } catch (err) {
      errors++;
      logError("enrich-kl", `  ERROR: ${(err as Error).message.slice(0, 100)}`);
    }
  }

  section("ENRICH-KLWINES COMPLETE");
  log(
    "enrich-kl",
    `scanned=${rows.length} scraped=${scraped} linked=${linked} new=${newProducts} prices=${prices} watched=${watched} errors=${errors}`,
  );
  return { scanned: rows.length, scraped, linked, newProducts, prices, watched, errors };
}
