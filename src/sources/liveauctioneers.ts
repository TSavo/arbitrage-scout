/**
 * LiveAuctioneers marketplace adapter — major auction aggregator.
 *
 * Uses Playwright to intercept the internal search API, then replays
 * requests directly via fetch. Same approach as HiBid.
 *
 * Rate limited to 1 req/2.5s.
 */

import { log, error } from "@/lib/logger";
import type { IMarketplaceAdapter, RawListing } from "./IMarketplaceAdapter";
import { makeRawListing } from "./IMarketplaceAdapter";
import { cachedFetch } from "@/lib/cached_fetch";
import { withSharedPage } from "@/lib/shared_browser";

const RATE_LIMIT_MS = 2500;

export class LiveAuctioneersAdapter implements IMarketplaceAdapter {
  readonly marketplace_id = "liveauctioneers";
  private lastCallAt = 0;
  private sessionReady = false;
  private searchUrl = "";
  private searchHeaders: Record<string, string> = {};
  private searchBody: string = "";

  discoveryQueries(): string[] {
    return [
      "video games",
      "nintendo",
      "playstation",
      "sega genesis",
      "pokemon cards",
      "magic the gathering",
      "trading cards",
      "sports cards",
      "comic books",
      "vinyl records",
      "funko pop",
      "lego",
      "coins collection",
    ];
  }

  async initSession(): Promise<boolean> {
    if (this.sessionReady) return true;

    log("liveauctioneers", "initializing Playwright session to intercept search API");
    try {
      return await withSharedPage(async (page) => {
        let captured = false;

        // Intercept requests to find the search API
        page.on("request", (req: { url: () => string; method: () => string; headers: () => Record<string, string>; postData: () => string | null }) => {
          const url = req.url();
          if (captured) return;
          // Look for search-related API calls
          if (
            (url.includes("search") || url.includes("catalog") || url.includes("item")) &&
            url.includes("liveauctioneers") &&
            req.method() === "POST"
          ) {
            this.searchUrl = url;
            this.searchHeaders = req.headers();
            this.searchBody = req.postData() ?? "";
            captured = true;
            log("liveauctioneers", `captured search API: ${url}`);
          }
        });

        await page.goto("https://www.liveauctioneers.com/search/?keyword=nintendo", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        // If we didn't capture a POST, try scrolling to trigger lazy load
        if (!captured) {
          await page.evaluate(() => window.scrollBy(0, 1000));
          await page.waitForTimeout(3000);
        }

        if (captured) {
          this.sessionReady = true;
          log("liveauctioneers", "session ready — search API captured");
          return true;
        }

        // Fallback: try HTML scraping approach
        log("liveauctioneers", "no API intercepted — will use HTML scraping");
        this.sessionReady = true;
        return true;
      });
    } catch (err) {
      error("liveauctioneers", "Playwright session failed", err);
      return false;
    }
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_MS - elapsed));
    }
    this.lastCallAt = Date.now();
  }

  async search(
    query: string,
    options: { max_price?: number; limit?: number } = {},
  ): Promise<RawListing[]> {
    if (!this.sessionReady) {
      const ok = await this.initSession();
      if (!ok) return [];
    }

    const limit = options.limit ?? 40;
    log("liveauctioneers", `searching: "${query}" limit=${limit}`);

    // If we captured an API, replay it
    if (this.searchUrl && this.searchBody) {
      return this.searchViaApi(query, limit, options.max_price);
    }

    // Fallback: scrape HTML via Playwright
    return this.searchViaHtml(query, limit, options.max_price);
  }

  private async searchViaApi(
    query: string,
    limit: number,
    maxPrice?: number,
  ): Promise<RawListing[]> {
    await this.rateLimit();

    // Parse the captured body as JSON and replace the keyword field properly
    let body: string;
    try {
      const parsed = JSON.parse(this.searchBody);
      this.injectKeyword(parsed, query);
      body = JSON.stringify(parsed);
    } catch {
      // Not valid JSON (e.g. protobuf) — fall back to HTML scraper
      log("liveauctioneers", "captured body is not JSON, falling back to HTML scraper");
      return this.searchViaHtml(query, limit, maxPrice);
    }

    const t0 = Date.now();
    try {
      const resp = await cachedFetch(this.searchUrl, {
        method: "POST",
        headers: this.searchHeaders,
        body,
      }, {
        ttlMs: 10 * 60 * 1000,
        cacheTag: "liveauctioneers-search",
      });

      if (!resp.ok) {
        error("liveauctioneers", `API ${resp.status} elapsed=${Date.now() - t0}ms`);
        return [];
      }

      const data = resp.json<Record<string, unknown>>();
      const items = this.extractItems(data);
      log("liveauctioneers", `API returned ${items.length} items elapsed=${Date.now() - t0}ms`);

      return this.mapToListings(items, limit, maxPrice);
    } catch (err) {
      error("liveauctioneers", `API call failed`, err);
      return [];
    }
  }

  private async searchViaHtml(
    query: string,
    limit: number,
    maxPrice?: number,
  ): Promise<RawListing[]> {
    log("liveauctioneers", `HTML scraping: "${query}"`);
    try {
      return await withSharedPage(async (page) => {
        await page.goto(
          `https://www.liveauctioneers.com/search/?keyword=${encodeURIComponent(query)}`,
          { waitUntil: "domcontentloaded", timeout: 30000 },
        );

        // Extract items from the page
        const scraped = await page.evaluate(() => {
          const results: Array<{ title: string; price: string; url: string; image: string; id: string }> = [];
          // Try multiple selector strategies
          const cards = document.querySelectorAll('[class*="ItemCard"], [class*="item-card"], [data-testid*="item"], article');
          for (const card of cards) {
            const titleEl = card.querySelector('h3, h4, [class*="title"], [class*="Title"]');
            const priceEl = card.querySelector('[class*="price"], [class*="Price"], [class*="bid"]');
            const linkEl = card.querySelector('a[href*="/item/"]') as HTMLAnchorElement | null;
            const imgEl = card.querySelector('img') as HTMLImageElement | null;

            if (titleEl && linkEl) {
              results.push({
                title: titleEl.textContent?.trim() ?? "",
                price: priceEl?.textContent?.trim() ?? "0",
                url: linkEl.href,
                image: imgEl?.src ?? "",
                id: linkEl.href.match(/\/item\/(\d+)/)?.[1] ?? "",
              });
            }
          }
          return results;
        });

        let listings = scraped
          .filter((s: { title: string; id: string }) => s.title && s.id)
          .slice(0, limit)
          .map((s: { title: string; price: string; url: string; image: string; id: string }): RawListing => {
            const price = parseFloat(s.price.replace(/[^0-9.]/g, "")) || 0;
            return makeRawListing({
              marketplace_id: "liveauctioneers",
              listing_id: s.id,
              title: s.title,
              price_usd: price,
              url: s.url,
              image_url: s.image || undefined,
            });
          });

        if (maxPrice) {
          listings = listings.filter((l: RawListing) => l.price_usd <= maxPrice);
        }

        log("liveauctioneers", `HTML scraped ${listings.length} items`);
        return listings;
      });
    } catch (err) {
      error("liveauctioneers", `HTML scraping failed`, err);
      return [];
    }
  }

  /**
   * Recursively inject keyword into a parsed JSON body.
   * Looks for common field names: keyword, query, searchText, etc.
   */
  private injectKeyword(obj: Record<string, unknown>, keyword: string): void {
    for (const key of Object.keys(obj)) {
      const lk = key.toLowerCase();
      if (
        lk === "keyword" ||
        lk === "searchkeyword" ||
        lk === "query" ||
        lk === "searchtext" ||
        lk === "searchquery" ||
        lk === "search" ||
        lk === "term" ||
        lk === "q"
      ) {
        if (typeof obj[key] === "string") {
          obj[key] = keyword;
        }
      } else if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
        this.injectKeyword(obj[key] as Record<string, unknown>, keyword);
      }
    }
  }

  /** Recursively search JSON for arrays of item-like objects */
  private extractItems(data: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(data)) {
      if (data.length > 0 && typeof data[0] === "object" && data[0] !== null) {
        const first = data[0] as Record<string, unknown>;
        if ("title" in first || "lotTitle" in first || "itemTitle" in first) {
          return data as Array<Record<string, unknown>>;
        }
      }
      for (const item of data) {
        const result = this.extractItems(item);
        if (result.length > 0) return result;
      }
    } else if (typeof data === "object" && data !== null) {
      for (const val of Object.values(data)) {
        const result = this.extractItems(val);
        if (result.length > 0) return result;
      }
    }
    return [];
  }

  private mapToListings(
    items: Array<Record<string, unknown>>,
    limit: number,
    maxPrice?: number,
  ): RawListing[] {
    let listings = items.slice(0, limit).map((item): RawListing => {
      const id = String(item.itemId ?? item.id ?? item.lotId ?? "");
      const title = String(item.title ?? item.lotTitle ?? item.itemTitle ?? "");
      const price = Number(item.currentBid ?? item.startPrice ?? item.estimateLow ?? 0);
      const image = item.imageUrl ?? item.thumbnailUrl ?? item.image;

      return makeRawListing({
        marketplace_id: "liveauctioneers",
        listing_id: id,
        title,
        price_usd: price,
        url: `https://www.liveauctioneers.com/item/${id}`,
        image_url: image ? String(image) : undefined,
        num_bids: Number(item.bidCount ?? 0),
        extra: {
          auction_house: item.houseName ?? item.auctionHouse,
          estimate_low: item.estimateLow,
          estimate_high: item.estimateHigh,
          is_sold: item.isSold,
        },
      });
    });

    if (maxPrice) {
      listings = listings.filter((l) => l.price_usd <= maxPrice);
    }

    return listings;
  }

  isAvailable(): boolean {
    return true;
  }
}
