/**
 * K&L Wines adapter — scrapes the authenticated "New Product Feed" page.
 *
 * K&L doesn't expose a public API; the New Product Feed is a server-rendered
 * table behind a signed-in session. This adapter connects to a local Chrome
 * instance launched by scripts/klwines_login.ts (real Chrome, persistent
 * user-data-dir, CDP on :9222) so we inherit an authenticated session without
 * shipping credentials through this code.
 *
 * The feed lists every new SKU with: first-seen timestamp, SKU, vintage,
 * name, price, and inventory count. Each row is one RawListing.
 *
 * Discovery is trivial for K&L — the feed IS the discovery. `search(query)`
 * filters the feed client-side by title substring so the IMarketplaceAdapter
 * contract still holds, but the natural call is `fetchNewFeed()` which returns
 * the full page.
 */

import { type Page } from "playwright";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  IMarketplaceAdapter,
  RawListing,
  makeRawListing,
} from "./IMarketplaceAdapter";
import { getSharedContext } from "@/lib/shared_browser";
import { log, error } from "@/lib/logger";

const PAGE_SIZE = 50;

/**
 * K&L has multiple scrape targets, each with its own filter set:
 *   - Auction feeds (multiple; facet 30 selects auction category groups)
 *   - New Product Feed (newly catalogued retail SKUs)
 *
 * All are /Products (or /p/Index) URLs with filter facets. We scrape every
 * configured feed on each scan and merge by SKU.
 */
export interface KlwinesFeedDef {
  readonly name: string;
  readonly url: string;
}

const DEFAULT_FEEDS: readonly KlwinesFeedDef[] = [
  {
    name: "auction_216",
    url: "https://www.klwines.com/Products?&filters=sv2_dflt-stock-instock!30$eq$(216)$True$ff-30-(216)--$!88$eq$1$True$ff-88-1--$&orderBy=60%20asc,search.score()%20desc,74%20asc",
  },
  {
    name: "auction_227_group",
    url: "https://www.klwines.com/Products?&filters=sv2_dflt-stock-instock!30$eq$(227)$True$ff-30-(227)--$or,220.or,219.or,215.or,218!88$eq$1$True$ff-88-1--$&orderBy=60%20asc,search.score()%20desc,74%20asc",
  },
  {
    name: "new_product",
    url: "https://www.klwines.com/p/Index?filters=sv2_NewProductFeedYN%24eq%241%24True%24ProductFeed%24%21dflt-stock-all&orderBy=NewProductFeedDate%20desc",
  },
];

// Human-cadence delays — K&L flags machine-speed interactions. Every click
// or scrape is preceded by a 2–4s jittered wait.
const MIN_DELAY_MS = 2_000;
const MAX_DELAY_MS = 4_000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function humanDelay(): Promise<void> {
  const ms = MIN_DELAY_MS + Math.floor(Math.random() * (MAX_DELAY_MS - MIN_DELAY_MS));
  return sleep(ms);
}
const DEFAULT_USER_DATA_DIR = resolve("data/sessions/klwines");

export interface KlwinesConfig {
  readonly userDataDir?: string;
  readonly cdpPort?: number;
  /** @deprecated — no longer used. Shared browser handles connection. */
  readonly autoSpawn?: boolean;
}

type FeedKind = "auction" | "new_product";

function feedKind(def: KlwinesFeedDef): FeedKind {
  return /NewProductFeedYN/.test(def.url) ? "new_product" : "auction";
}

interface FeedRow {
  readonly kind: FeedKind;
  readonly sku: string;
  readonly title: string;
  readonly url: string;
  readonly priceUsd: number;
  /** New-product feed: inventory qty. Auction: items-in-lot count (from blurb). */
  readonly qty: number;
  /** New-product feed: first-seen-at timestamp. Auction: undefined. */
  readonly firstSeenAt?: string;
  /** New-product feed: vintage column. Auction: parsed from title if present. */
  readonly vintage?: string;
  /** Auction only: "Apr 14 2026 9:40AM PT" */
  readonly auctionEndAt?: string;
  /** Auction only: current bid in USD (duplicates priceUsd for clarity). */
  readonly currentBidUsd?: number;
  /** Auction only: full lot description (e.g. "2002 Plantation 15 Year Old Barbados Rum (qty: 1)"). */
  readonly lotDescription?: string;
  /** Auction only: the marketing blurb text ("Bid on this bottle of..."
   *  or the full editorial description if K&L included one). Passed to
   *  the LLM as listing description. */
  readonly description?: string;
  /** Either feed: image URL if present. */
  readonly imageUrl?: string;
}

export class KlwinesAdapter implements IMarketplaceAdapter {
  readonly marketplace_id = "klwines";

  private readonly userDataDir: string;
  private _lastError: string | null = null;

  constructor(cfg: KlwinesConfig = {}) {
    this.userDataDir = cfg.userDataDir ?? DEFAULT_USER_DATA_DIR;
  }

  isAvailable(): boolean {
    return existsSync(this.userDataDir) && this._lastError === null;
  }

  discoveryQueries(): string[] {
    // K&L's natural shape is "fetch the whole new-product feed once per scan",
    // not per-keyword discovery. A single empty query returns the full feed.
    return [""];
  }

  /**
   * Streaming variant — yields listings as each page is scraped, so the
   * downstream pipeline can start classifying page-1 results while the
   * scraper is still clicking through later pages. Same feeds, same dedup
   * semantics as search(), just incremental.
   */
  async *stream(
    query: string,
    options: { max_price?: number; limit?: number } = {},
  ): AsyncIterable<RawListing> {
    const q = query.trim().toLowerCase();
    let emitted = 0;
    const limit = options.limit;

    for (const def of DEFAULT_FEEDS) {
      try {
        for await (const row of this._streamFeed(def)) {
          if (q && !row.title.toLowerCase().includes(q)) continue;
          if (options.max_price != null && row.priceUsd > options.max_price) continue;
          yield rowToListing(row);
          emitted++;
          if (limit && emitted >= limit) return;
        }
      } catch (err) {
        this._lastError = err instanceof Error ? err.message : String(err);
        error("klwines", `stream(${def.name}) failed: ${this._lastError}`);
      }
    }
  }

  async search(
    query: string,
    options: { max_price?: number; limit?: number } = {},
  ): Promise<RawListing[]> {
    try {
      // Scrape every configured feed. Do NOT dedupe across feeds by SKU: the
      // same product can be simultaneously for retail sale AND at auction —
      // that's the most interesting signal (same vendor, two prices). Instead,
      // dedupe only within a feed (by listing identity) and let both
      // retail+auction listings for the same SKU flow through. The pipeline
      // resolves them to the same product via the SKU external identifier.
      const all: FeedRow[] = [];
      for (const def of DEFAULT_FEEDS) {
        const rows = await this.fetchFeed(def);
        all.push(...rows);
      }
      let filtered: FeedRow[] = all;

      const q = query.trim().toLowerCase();
      if (q) {
        filtered = filtered.filter((r) => r.title.toLowerCase().includes(q));
      }
      if (options.max_price != null) {
        const maxPrice = options.max_price;
        filtered = filtered.filter((r) => r.priceUsd <= maxPrice);
      }
      if (options.limit) filtered = filtered.slice(0, options.limit);

      log(
        "klwines",
        `search: ${DEFAULT_FEEDS.length} feeds → scraped=${all.length} final=${filtered.length}`,
      );
      return filtered.map(rowToListing);
    } catch (err) {
      this._lastError = err instanceof Error ? err.message : String(err);
      error("klwines", `search failed: ${this._lastError}`);
      return [];
    }
  }

  /**
   * Scrape one feed end-to-end, paginating via in-page "next page" clicks.
   * K&L renders client-side; rapid URL-driven navigation trips bot defenses,
   * but a single goto to the feed URL followed by click-pagination behaves
   * like a real session.
   *
   * Dispatches to the feed-kind-appropriate scraper: TR-based for the new
   * product feed, card-based for auction feeds.
   */
  /** Yield one FeedRow at a time as pages are scraped. */
  private async *_streamFeed(
    def: KlwinesFeedDef,
    opts: { readonly maxPages?: number } = {},
  ): AsyncIterable<FeedRow> {
    const maxPages = opts.maxPages ?? 40;
    const kind = feedKind(def);
    const page = await this._getPage();
    const seen = new Set<string>();

    log("klwines", `stream(${def.name}, kind=${kind}) → navigating`);
    await page.goto(def.url, { waitUntil: "domcontentloaded", timeout: 30_000 });

    // K&L sits behind a Cloudflare managed challenge that serves an
    // interstitial 403 HTML page first; Chrome's built-in JS execution
    // solves the challenge after a few seconds and the real K&L content
    // loads. "domcontentloaded" fires on the CHALLENGE page, not the real
    // one — so we explicitly wait for the K&L-specific title/URL.
    await page.waitForFunction(
      () => !/Just a moment/i.test(document.title) && document.title.includes("K&L"),
      { timeout: 45_000 },
    ).catch(() => {
      log("klwines", `${def.name}: Cloudflare challenge didn't resolve within 45s`);
    });
    await humanDelay();

    const rowSelector =
      kind === "new_product"
        ? 'tr td a[href*="/p/"]'
        : 'div.tf-product a[href*="/Auction/"]';

    for (let i = 0; i < maxPages; i++) {
      try {
        await page.waitForSelector(rowSelector, { timeout: 30_000 });
      } catch {
        log("klwines", `${def.name} page ${i + 1}: no products rendered — stopping`);
        break;
      }
      await sleep(500);

      const rows =
        kind === "new_product"
          ? await this._scrapeNewProductRows(page)
          : await this._scrapeAuctionCards(page);

      let added = 0;
      for (const r of rows) {
        if (seen.has(r.sku)) continue;
        seen.add(r.sku);
        added++;
        yield r;
      }
      log(
        "klwines",
        `${def.name} page ${i + 1} → ${rows.length} rows (${added} new), emitted total=${seen.size}`,
      );

      const clicked = await this._clickNextPage(page, i + 1);
      if (!clicked) {
        log("klwines", `${def.name}: no next-page link — stopping at page ${i + 1}`);
        break;
      }
    }
  }

  async fetchFeed(
    def: KlwinesFeedDef,
    opts: { readonly maxPages?: number } = {},
  ): Promise<readonly FeedRow[]> {
    const maxPages = opts.maxPages ?? 40; // safety cap → 2000 rows
    const kind = feedKind(def);
    const page = await this._getPage();
    const t0 = Date.now();
    const seen = new Set<string>();
    const all: FeedRow[] = [];

    log("klwines", `fetchFeed(${def.name}, kind=${kind}) → navigating`);
    await page.goto(def.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await humanDelay();

    const rowSelector =
      kind === "new_product"
        ? 'tr td a[href*="/p/"]'
        : 'div.tf-product a[href*="/Auction/"]';

    for (let i = 0; i < maxPages; i++) {
      try {
        await page.waitForSelector(rowSelector, { timeout: 20_000 });
      } catch {
        log("klwines", `${def.name} page ${i + 1}: no products rendered — stopping`);
        break;
      }
      // Let the Algolia-driven render settle.
      await sleep(500);

      const rows =
        kind === "new_product"
          ? await this._scrapeNewProductRows(page)
          : await this._scrapeAuctionCards(page);

      let added = 0;
      for (const r of rows) {
        if (seen.has(r.sku)) continue;
        seen.add(r.sku);
        all.push(r);
        added++;
      }
      log(
        "klwines",
        `${def.name} page ${i + 1} → ${rows.length} rows (${added} new), running total=${all.length}`,
      );

      const clicked = await this._clickNextPage(page, i + 1);
      if (!clicked) {
        log("klwines", `${def.name}: no next-page link — stopping at page ${i + 1}`);
        break;
      }
    }

    log(
      "klwines",
      `fetchFeed(${def.name}) → ${all.length} total rows elapsed=${Date.now() - t0}ms`,
    );
    this._lastError = null;
    return Object.freeze(all);
  }

  /**
   * Click the link for page N+1 in K&L's pagination strip. Returns false if
   * no such link is present (= last page).
   */
  private async _clickNextPage(page: Page, currentPage: number): Promise<boolean> {
    const nextPageNum = currentPage + 1;
    // Try the numbered "Go to N page" link first; fall back to generic "next >>"
    // (rendered as text "next >>" or "next »" in K&L's pagination widget).
    const candidates = [
      `.page-filters-block a[aria-label="Go to ${nextPageNum} page"]`,
      `.page-filters-block a[aria-label*="next" i]`,
      `.page-filters-block a:has-text("next")`,
    ];
    for (const sel of candidates) {
      const link = page.locator(sel).first();
      const count = await link.count().catch(() => 0);
      if (count === 0) continue;
      await link.scrollIntoViewIfNeeded().catch(() => {});
      await humanDelay();
      try {
        await Promise.all([
          page.waitForLoadState("domcontentloaded", { timeout: 15_000 }),
          link.click(),
        ]);
        await humanDelay();
        return true;
      } catch {
        // try next candidate
      }
    }
    return false;
  }

  private async _scrapeNewProductRows(page: Page): Promise<FeedRow[]> {
    const raw = await page.evaluate(() => {
      type Raw = { firstSeenAt: string; sku: string; vintage: string; title: string; url: string; priceUsd: number; qty: number };
      const out: Raw[] = [];
      for (const tr of Array.from(document.querySelectorAll("tr"))) {
        const tds = tr.querySelectorAll("td");
        if (tds.length < 6) continue;
        const anchor = (tds[3] as HTMLElement).querySelector("a") as HTMLAnchorElement | null;
        if (!anchor) continue;
        const href = anchor.href;
        if (!href || !/\/p\//.test(href)) continue;

        const sku = ((tds[1] as HTMLElement).textContent ?? "").trim();
        if (!/^\d+$/.test(sku)) continue;

        const priceText = ((tds[4] as HTMLElement).textContent ?? "").replace(/[^0-9.]/g, "");
        const priceUsd = parseFloat(priceText);
        if (!Number.isFinite(priceUsd)) continue;

        const qtyText = ((tds[5] as HTMLElement).textContent ?? "").replace(/[^0-9]/g, "");
        const qty = qtyText ? parseInt(qtyText, 10) : 0;

        out.push({
          firstSeenAt: (tds[0] as HTMLElement).getAttribute("value") ?? ((tds[0] as HTMLElement).textContent ?? "").trim(),
          sku,
          vintage: ((tds[2] as HTMLElement).textContent ?? "").trim(),
          title: (anchor.textContent ?? "").trim(),
          url: href,
          priceUsd,
          qty,
        });
      }
      return out;
    });
    return raw.map((r) => ({ ...r, kind: "new_product" as const }));
  }

  private async _scrapeAuctionCards(page: Page): Promise<FeedRow[]> {
    const raw = await page.evaluate(() => {
      type Raw = {
        sku: string;
        title: string;
        url: string;
        priceUsd: number;
        qty: number;
        auctionEndAt?: string;
        lotDescription?: string;
        description?: string;
        imageUrl?: string;
      };
      const out: Raw[] = [];
      const cards = Array.from(document.querySelectorAll("div.tf-product.clearfix"));
      for (const card of cards) {
        // Title + SKU come from the header anchor.
        const headerAnchor = card.querySelector(
          'div.tf-product-header a[href*="/Auction/"]',
        ) as HTMLAnchorElement | null;
        if (!headerAnchor) continue;
        const href = headerAnchor.href;
        const skuMatch = href.match(/[?&]sku=(\d+)/);
        if (!skuMatch) continue;
        const sku = skuMatch[1];
        const title = (headerAnchor.textContent ?? "").replace(/\s+/g, " ").trim();

        // Current bid.
        let priceUsd = NaN;
        const priceEl = card.querySelector("div.tf-price");
        if (priceEl) {
          const bidText = (priceEl.textContent ?? "").replace(/[^0-9.]/g, "");
          priceUsd = parseFloat(bidText);
        }
        if (!Number.isFinite(priceUsd)) continue;

        // End date.
        const endEl = card.querySelector("strong.tf-auction-end-time");
        const auctionEndAt = endEl
          ? (endEl.textContent ?? "").replace(/^\s*End Date:\s*/i, "").replace(/\s+/g, " ").trim()
          : undefined;

        // Lot contents: "<name> (qty: N)"
        const lotEl = card.querySelector("div.tf-items");
        const lotDescription = lotEl ? (lotEl.textContent ?? "").replace(/\s+/g, " ").trim() : undefined;
        const qtyMatch = lotDescription?.match(/qty:\s*(\d+)/i);
        const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : 1;

        // Marketing blurb / editorial description. On K&L this lives in
        // div.tf-product-description and typically contains "Bid on this
        // bottle of ..." plus any notes the buyer wrote. Load-bearing for
        // LLM classify/extract — without it, the model only sees the title.
        const descEl = card.querySelector("div.tf-product-description");
        const description = descEl ? (descEl.textContent ?? "").replace(/\s+/g, " ").trim() : undefined;

        const imgEl = card.querySelector("div.tf-product-image img") as HTMLImageElement | null;
        const imageUrl = imgEl?.src ?? undefined;

        out.push({ sku, title, url: href, priceUsd, qty, auctionEndAt, lotDescription, description, imageUrl });
      }
      return out;
    });

    return raw.map((r) => {
      // Vintage can often be pulled off the title ("2002 Plantation 15 Year…")
      const vintageMatch = r.title.match(/^(\d{4})\b/);
      return {
        kind: "auction" as const,
        sku: r.sku,
        title: r.title,
        url: r.url,
        priceUsd: r.priceUsd,
        currentBidUsd: r.priceUsd,
        qty: r.qty,
        vintage: vintageMatch ? vintageMatch[1] : undefined,
        auctionEndAt: r.auctionEndAt,
        lotDescription: r.lotDescription,
        description: r.description,
        imageUrl: r.imageUrl,
      };
    });
  }

  async close(): Promise<void> {
    // No-op — the shared browser stays connected across adapter lifetimes.
    // Only the top-level scan runner closes it (via closeSharedBrowser()).
  }

  // ── internals ─────────────────────────────────────────────────────────

  /**
   * Get a page for scraping K&L. Prefers reusing an existing klwines tab
   * in the shared Chrome (carries the logged-in cookies + bot-detection
   * history). Falls back to opening a new tab in the same context, which
   * still inherits the profile's cookies since the whole context shares
   * one user-data-dir.
   */
  private async _getPage(): Promise<Page> {
    const ctx = await getSharedContext();
    const klTabs = ctx.pages().filter((p) => p.url().includes("klwines.com"));
    const page = klTabs.length
      ? (klTabs.find((p) => /NewProductFeedYN|\/Products\?/.test(p.url())) ?? klTabs[0])
      : await ctx.newPage();
    // Pull the tab to the foreground so the headed Chrome visibly shows
    // K&L's scraping progress alongside whatever other adapters are doing.
    await page.bringToFront().catch(() => {});
    return page;
  }
}

function rowToListing(row: FeedRow): RawListing {
  // Title usually already contains the vintage; only prepend it if missing.
  const title =
    row.vintage && !row.title.startsWith(row.vintage)
      ? `${row.vintage} ${row.title}`
      : row.title;

  const extra: Record<string, unknown> = {
    // Namespaced so persist's EXTERNAL_ID_KEYS picks it up as a
    // klwines_sku product_identifier. First listing of a given SKU runs the
    // full classify walk; subsequent listings (any channel, any scan) hit
    // tier-1 and skip straight to opportunity eval.
    klwines_sku: row.sku,
    feed_kind: row.kind,
    vintage: row.vintage,
  };
  if (row.kind === "new_product") {
    extra.first_seen_at = row.firstSeenAt;
    extra.qty_available = row.qty;
  } else {
    extra.current_bid_usd = row.currentBidUsd;
    extra.auction_end_at = row.auctionEndAt;
    extra.lot_description = row.lotDescription;
    extra.lot_qty = row.qty;
  }

  // Distinct listing_id per channel — both channels can legitimately carry the
  // same SKU concurrently (retail in-stock AND at auction). Downstream the
  // SKU (in extra) is the external product identifier; the listing_id keeps
  // the two rows separate in the listings table.
  const listingId = row.kind === "auction" ? `au-${row.sku}` : `rt-${row.sku}`;

  // Build the description the LLM will see. For auctions, combine the
  // editorial blurb + lot contents; for new-product feed there's nothing
  // extra beyond the title.
  const descriptionParts = [row.description, row.lotDescription].filter(Boolean);
  const description = descriptionParts.length
    ? descriptionParts.join("\n")
    : undefined;

  return makeRawListing({
    marketplace_id: "klwines",
    listing_id: listingId,
    title,
    price_usd: row.priceUsd,
    shipping_usd: 0,
    url: row.url,
    description,
    image_url: row.imageUrl,
    item_count: row.kind === "auction" ? row.qty : 1,
    end_time: row.auctionEndAt,
    extra,
  });
}
