/**
 * Mercari marketplace adapter — US resale marketplace.
 *
 * Mercari uses a BFF (Backend-for-Frontend) service over Connect Protocol
 * (gRPC over HTTP). The search API is not publicly documented.
 *
 * We use Playwright to:
 * 1. Navigate to mercari.com/search, passing bot detection
 * 2. Intercept the internal search API call (typically /v1/api or similar)
 * 3. Capture the endpoint URL, headers, cookies, and request body format
 * 4. Replay those for subsequent searches via fetch()
 *
 * Rate limited to 1 req per 2.5 seconds.
 */

import { log, error } from "@/lib/logger";
import type { IMarketplaceAdapter, RawListing } from "./IMarketplaceAdapter";
import { makeRawListing } from "./IMarketplaceAdapter";

const RATE_LIMIT_MS = 2500;
const SESSION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Shape of a captured search API request from Playwright interception.
 * We store everything needed to replay the call with fetch().
 */
interface CapturedSearchRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** The POST body template — we'll swap in the keyword at search time */
  bodyTemplate: unknown;
}

export class MercariAdapter implements IMarketplaceAdapter {
  marketplace_id = "mercari";

  private cookies: string = "";
  private userAgent: string = "";
  private captured: CapturedSearchRequest | null = null;
  private lastCallAt = 0;
  private sessionReady = false;
  private sessionInitAt = 0;
  private browser: any = null;

  discoveryQueries(): string[] {
    return [
      "video games lot",
      "nintendo games",
      "pokemon cards",
      "magic the gathering",
      "vinyl records",
      "funko pop lot",
      "sega genesis",
      "comic books lot",
      "lego sets",
      "playstation games",
      "xbox games",
      "trading cards lot",
      "board games",
      "retro games",
      "game boy",
      "dvd blu-ray lot",
      "action figures lot",
      "hot wheels lot",
    ];
  }

  /**
   * Launch Playwright, navigate to Mercari search, and intercept the
   * internal API call to discover the search endpoint + auth headers.
   */
  async initSession(): Promise<boolean> {
    if (this.sessionReady && Date.now() - this.sessionInitAt < SESSION_MAX_AGE_MS) {
      return true;
    }

    // Reset state for fresh session
    this.sessionReady = false;
    this.captured = null;

    log("mercari", "initializing Playwright session for API interception");
    try {
      const { chromium } = require("playwright");
      // Try headless first (works if cookies are cached or no Cloudflare).
      // Fall back to headed if HEADED=1 env is set (for interactive sessions).
      const headed = process.env.HEADED === "1";
      const browser = await chromium.launch({ headless: !headed });
      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      });
      const page = await context.newPage();

      // Set up request interception to capture the search API call
      let capturedRequest: CapturedSearchRequest | null = null;

      page.on("request", (req: { url: () => string; method: () => string; headers: () => Record<string, string>; postData: () => string | null }) => {
        const url = req.url();
        // Mercari's internal API calls go through /v1/api or similar paths
        // Also watch for Connect/gRPC-style endpoints
        if (
          (url.includes("/v1/api") ||
            url.includes("/api/") ||
            url.includes("search") ||
            url.includes("entity") ||
            url.includes("item")) &&
          url.includes("mercari.com") &&
          req.method() === "POST" &&
          !url.includes("analytics") &&
          !url.includes("log") &&
          !url.includes("track") &&
          !url.includes("event")
        ) {
          const postData = req.postData();
          if (postData) {
            try {
              const body = JSON.parse(postData);
              // Look for search-related payloads
              if (
                JSON.stringify(body).toLowerCase().includes("keyword") ||
                JSON.stringify(body).toLowerCase().includes("search") ||
                JSON.stringify(body).toLowerCase().includes("query")
              ) {
                log("mercari", `captured search API: ${req.method()} ${url}`);
                capturedRequest = {
                  url,
                  method: req.method(),
                  headers: { ...req.headers() },
                  bodyTemplate: body,
                };
              }
            } catch {
              // Not JSON, skip
            }
          }
        }
      });

      // Navigate to a search page to trigger the search API call
      log("mercari", "navigating to mercari.com/search");
      await page.goto("https://www.mercari.com/search/?keyword=nintendo+games", {
        waitUntil: "networkidle",
        timeout: 45000,
      });

      // Wait a beat for any deferred API calls
      await page.waitForTimeout(3000);

      // Grab cookies and user agent
      const allCookies = await context.cookies();
      this.cookies = allCookies
        .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
        .join("; ");
      this.userAgent = await page.evaluate(() => navigator.userAgent);

      // If we didn't capture a POST API call, try scrolling to trigger lazy loads
      if (!capturedRequest) {
        log("mercari", "no API call captured yet, scrolling to trigger lazy load");
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(3000);
      }

      // If still nothing, try intercepting via page.route on a fresh navigation
      if (!capturedRequest) {
        log("mercari", "attempting second navigation with route interception");

        const responsePromise = new Promise<void>((resolve) => {
          page.on("response", (resp: { url: () => string; status: () => number; text: () => Promise<string>; request: () => { method: () => string; headers: () => Record<string, string>; postData: () => string | null } }) => {
            const url = resp.url();
            if (
              url.includes("mercari.com") &&
              (url.includes("/v1/") || url.includes("/api/") || url.includes("search")) &&
              !url.includes("analytics") &&
              !url.includes("track") &&
              resp.status() === 200
            ) {
              const req = resp.request();
              if (req.method() === "POST") {
                const postData = req.postData();
                if (postData) {
                  try {
                    const body = JSON.parse(postData);
                    log("mercari", `captured via response: ${req.method()} ${url}`);
                    capturedRequest = {
                      url,
                      method: req.method(),
                      headers: { ...req.headers() },
                      bodyTemplate: body,
                    };
                    resolve();
                  } catch {
                    // skip
                  }
                }
              }
            }
          });
        });

        await page.goto("https://www.mercari.com/search/?keyword=pokemon+cards", {
          waitUntil: "networkidle",
          timeout: 45000,
        });

        // Give it a few seconds
        await Promise.race([responsePromise, page.waitForTimeout(5000)]);
      }

      await browser.close();

      if (capturedRequest) {
        this.captured = capturedRequest;
        this.sessionReady = true;
        this.sessionInitAt = Date.now();
        log(
          "mercari",
          `session ready — API endpoint: ${(capturedRequest as CapturedSearchRequest).url} (${allCookies.length} cookies)`,
        );
        return true;
      }

      // Fallback: we have cookies but no captured API endpoint.
      // We can still try the HTML scraping fallback.
      if (this.cookies) {
        this.sessionReady = true;
        this.sessionInitAt = Date.now();
        log(
          "mercari",
          `session ready (HTML fallback mode, no API intercepted) (${allCookies.length} cookies)`,
        );
        return true;
      }

      error("mercari", "no cookies or API endpoint obtained from Playwright session");
      return false;
    } catch (err) {
      error("mercari", "Playwright session failed", err);
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

  /**
   * Search via the captured internal API endpoint.
   * Replays the intercepted request with a swapped keyword.
   */
  private async searchViaApi(
    query: string,
    options: { max_price?: number; limit?: number },
  ): Promise<RawListing[]> {
    if (!this.captured) return [];

    await this.rateLimit();

    const limit = options.limit ?? 30;

    // Clone the captured body and inject our search keyword
    const body = JSON.parse(JSON.stringify(this.captured.bodyTemplate));
    this.injectKeyword(body, query);
    if (options.max_price) {
      this.injectMaxPrice(body, options.max_price);
    }

    const t0 = Date.now();
    try {
      const resp = await fetch(this.captured.url, {
        method: this.captured.method,
        headers: {
          ...this.captured.headers,
          Cookie: this.cookies,
          "User-Agent": this.userAgent,
        },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        error("mercari", `API ${resp.status} elapsed=${Date.now() - t0}ms`);
        if (resp.status === 403 || resp.status === 401) {
          log("mercari", "auth/bot detection — session expired, will re-init");
          this.sessionReady = false;
        }
        return [];
      }

      const data = await resp.json();
      log("mercari", `API search elapsed=${Date.now() - t0}ms`);

      return this.parseApiResponse(data, limit, options.max_price);
    } catch (err) {
      error("mercari", "API search failed", err);
      return [];
    }
  }

  /**
   * Recursively inject keyword into the captured body template.
   * Looks for common field names: keyword, searchKeyword, query, searchText, etc.
   */
  private injectKeyword(obj: Record<string, unknown>, keyword: string): void {
    for (const key of Object.keys(obj)) {
      const lk = key.toLowerCase();
      if (
        lk === "keyword" ||
        lk === "searchkeyword" ||
        lk === "query" ||
        lk === "searchtext" ||
        lk === "searchquery"
      ) {
        obj[key] = keyword;
      } else if (typeof obj[key] === "object" && obj[key] !== null) {
        this.injectKeyword(obj[key] as Record<string, unknown>, keyword);
      }
    }
  }

  /**
   * Inject max price filter into the captured body template.
   */
  private injectMaxPrice(obj: Record<string, unknown>, maxPrice: number): void {
    for (const key of Object.keys(obj)) {
      const lk = key.toLowerCase();
      if (lk === "pricemax" || lk === "price_max" || lk === "maxprice") {
        obj[key] = maxPrice * 100; // Mercari may use cents
      } else if (typeof obj[key] === "object" && obj[key] !== null) {
        this.injectMaxPrice(obj[key] as Record<string, unknown>, maxPrice);
      }
    }
  }

  /**
   * Parse the API response into RawListing[].
   * Since we don't know the exact shape until runtime, we search for
   * array fields that look like item lists.
   */
  private parseApiResponse(
    data: unknown,
    limit: number,
    maxPrice?: number,
  ): RawListing[] {
    const items = this.findItemArray(data);
    if (!items || items.length === 0) {
      log("mercari", "API response: no items found in response structure");
      return [];
    }

    log("mercari", `API response: found ${items.length} items`);

    let listings = items.slice(0, limit).map((item): RawListing => {
      const id = String(
        item.id || item.itemId || item.productId || item.listing_id || "",
      );
      const title = String(item.name || item.title || item.itemName || "");
      const priceRaw =
        item.price || item.currentPrice || item.originalPrice || 0;
      // Mercari US prices are in dollars (integer or float)
      const price = typeof priceRaw === "number" ? priceRaw : parseFloat(String(priceRaw)) || 0;
      // If price looks like cents (> 10000 for typical items), convert
      const priceUsd = price > 100000 ? price / 100 : price;

      const shippingRaw = item.shippingCost || item.shipping || 0;
      const shippingUsd =
        typeof shippingRaw === "number"
          ? shippingRaw
          : parseFloat(String(shippingRaw)) || 0;

      const imageUrl =
        item.imageUrl ||
        item.thumbnailUrl ||
        item.image ||
        (item.photos as string[] | undefined)?.[0] ||
        (item.thumbnails as string[] | undefined)?.[0] ||
        undefined;

      const url = id
        ? `https://www.mercari.com/us/item/${id}/`
        : undefined;

      const condition =
        item.condition || item.itemCondition || item.conditionId || undefined;

      const sellerObj = item.seller as Record<string, unknown> | undefined;
      const seller =
        sellerObj?.name || item.sellerName || item.seller_name || undefined;

      return makeRawListing({
        marketplace_id: "mercari",
        listing_id: id,
        title,
        price_usd: priceUsd,
        shipping_usd: shippingUsd,
        url,
        image_url: typeof imageUrl === "string" ? imageUrl : undefined,
        condition_raw: condition ? String(condition) : undefined,
        seller: seller ? String(seller) : undefined,
        extra: {
          raw_price: priceRaw,
        },
      });
    });

    if (maxPrice) {
      listings = listings.filter((l) => l.price_usd <= maxPrice);
    }

    return listings;
  }

  /**
   * Recursively search a JSON response for an array that looks like item results.
   */
  private findItemArray(obj: unknown, depth = 0): Record<string, unknown>[] | null {
    if (depth > 8) return null;
    if (Array.isArray(obj)) {
      // Check if this array contains objects that look like items
      if (
        obj.length > 0 &&
        typeof obj[0] === "object" &&
        obj[0] !== null &&
        this.looksLikeItem(obj[0] as Record<string, unknown>)
      ) {
        return obj as Record<string, unknown>[];
      }
    }
    if (typeof obj === "object" && obj !== null) {
      for (const val of Object.values(obj as Record<string, unknown>)) {
        const found = this.findItemArray(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Heuristic: does this object look like a marketplace item?
   */
  private looksLikeItem(obj: Record<string, unknown>): boolean {
    const keys = Object.keys(obj).map((k) => k.toLowerCase());
    const hasId = keys.some((k) => k === "id" || k === "itemid" || k === "productid");
    const hasName = keys.some(
      (k) => k === "name" || k === "title" || k === "itemname",
    );
    const hasPrice = keys.some(
      (k) => k === "price" || k === "currentprice" || k === "originalprice",
    );
    return (hasId && hasName) || (hasId && hasPrice) || (hasName && hasPrice);
  }

  /**
   * Fallback: scrape search results from the HTML page via Playwright.
   * Used when API interception fails.
   */
  private async searchViaHtml(
    query: string,
    options: { max_price?: number; limit?: number },
  ): Promise<RawListing[]> {
    await this.rateLimit();

    const limit = options.limit ?? 30;
    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `https://www.mercari.com/search/?keyword=${encodedQuery}`;

    log("mercari", `HTML fallback: fetching ${searchUrl}`);

    try {
      // Reuse the stored browser instance, or launch one if needed
      if (!this.browser) {
        const { chromium } = require("playwright");
        this.browser = await chromium.launch({ headless: true });
      }
      const context = await this.browser.newContext({
        userAgent: this.userAgent || undefined,
      });

      // Inject cookies if available
      if (this.cookies) {
        const cookiePairs = this.cookies.split("; ");
        const cookieObjects = cookiePairs.map((pair: string) => {
          const [name, ...valueParts] = pair.split("=");
          return {
            name: name.trim(),
            value: valueParts.join("="),
            domain: ".mercari.com",
            path: "/",
          };
        });
        await context.addCookies(cookieObjects);
      }

      const page = await context.newPage();

      // Collect API responses during page load for potential parsing
      let apiItems: Record<string, unknown>[] | null = null;
      page.on("response", async (resp: { url: () => string; status: () => number; text: () => Promise<string> }) => {
        const url = resp.url();
        if (
          url.includes("mercari.com") &&
          (url.includes("/v1/") || url.includes("/api/")) &&
          !url.includes("analytics") &&
          !url.includes("track") &&
          resp.status() === 200
        ) {
          try {
            const text = await resp.text();
            const json = JSON.parse(text);
            const found = this.findItemArray(json);
            if (found && found.length > 0) {
              apiItems = found;
              log("mercari", `HTML fallback: intercepted ${found.length} items from API response`);
            }
          } catch {
            // skip
          }
        }
      });

      await page.goto(searchUrl, {
        waitUntil: "networkidle",
        timeout: 45000,
      });

      await page.waitForTimeout(2000);

      // If we intercepted API items during page load, use those
      if (apiItems && (apiItems as Record<string, unknown>[]).length > 0) {
        await context.close();
        return this.parseApiResponse({ items: apiItems }, limit, options.max_price);
      }

      // Otherwise, parse HTML from the page
      const listings: RawListing[] = [];

      // Mercari renders items in a grid — look for item cards
      // The selectors may change; we try multiple strategies
      const itemSelectors = [
        '[data-testid="SearchResults"] [data-testid="ItemCell"]',
        '[data-testid="ItemCell"]',
        'a[href*="/item/"]',
        '[class*="ItemCell"]',
        '[class*="itemCell"]',
        'div[class*="SearchResult"] a',
      ];

      let itemElements: unknown[] = [];
      for (const selector of itemSelectors) {
        const count = await page.locator(selector).count();
        if (count > 0) {
          log("mercari", `HTML fallback: found ${count} items with selector "${selector}"`);
          itemElements = await page.locator(selector).all();
          break;
        }
      }

      if (itemElements.length === 0) {
        log("mercari", "HTML fallback: no item elements found on page");
        await context.close();
        return [];
      }

      for (const el of itemElements.slice(0, limit)) {
        try {
          const itemData = await (el as { evaluate: (fn: (node: HTMLElement) => Record<string, string | null>) => Promise<Record<string, string | null>> }).evaluate((node: HTMLElement) => {
            // Extract data from the item card element
            const link = node.closest("a") || node.querySelector("a");
            const href = link?.getAttribute("href") || "";
            const img = node.querySelector("img");
            const imgSrc = img?.getAttribute("src") || img?.getAttribute("data-src") || "";

            // Try to find price text
            const priceEl =
              node.querySelector('[class*="rice"]') ||
              node.querySelector('[data-testid*="rice"]') ||
              node.querySelector("p") ||
              null;
            const priceText = priceEl?.textContent || "";

            // Title
            const titleEl =
              node.querySelector('[class*="itle"]') ||
              node.querySelector('[data-testid*="itle"]') ||
              node.querySelector("span") ||
              null;
            const titleText = titleEl?.textContent || img?.getAttribute("alt") || "";

            return {
              href,
              imgSrc,
              priceText,
              titleText,
            };
          });

          const href = itemData.href || "";
          const idMatch = href.match(/\/item\/([a-zA-Z0-9]+)/);
          const id = idMatch ? idMatch[1] : href;

          if (!id || !itemData.titleText) continue;

          const priceMatch = (itemData.priceText || "").match(
            /\$?([\d,]+(?:\.\d{2})?)/,
          );
          const price = priceMatch
            ? parseFloat(priceMatch[1].replace(/,/g, ""))
            : 0;

          if (options.max_price && price > options.max_price) continue;

          listings.push(
            makeRawListing({
              marketplace_id: "mercari",
              listing_id: id,
              title: (itemData.titleText || "").trim(),
              price_usd: price,
              url: href.startsWith("http")
                ? href
                : `https://www.mercari.com${href}`,
              image_url: itemData.imgSrc || undefined,
            }),
          );
        } catch {
          // Skip items we can't parse
        }
      }

      await context.close();

      log("mercari", `HTML fallback: parsed ${listings.length} listings`);
      return listings;
    } catch (err) {
      error("mercari", "HTML fallback search failed", err);
      return [];
    }
  }

  async search(
    query: string,
    options: { max_price?: number; limit?: number } = {},
  ): Promise<RawListing[]> {
    if (!this.sessionReady) {
      const ok = await this.initSession();
      if (!ok) return [];
    }

    const limit = options.limit ?? 30;
    log("mercari", `searching: "${query}" limit=${limit}`);

    // Try the captured API first
    if (this.captured) {
      const results = await this.searchViaApi(query, options);
      if (results.length > 0) {
        log("mercari", `search "${query}": ${results.length} results via API`);
        return results;
      }
      log("mercari", "API returned no results, falling back to HTML");
    }

    // Fallback to HTML scraping via Playwright
    const results = await this.searchViaHtml(query, options);
    log("mercari", `search "${query}": ${results.length} results via HTML fallback`);
    return results;
  }

  async close(): Promise<void> {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // already closed
      }
      this.browser = null;
    }
    this.sessionReady = false;
  }

  isAvailable(): boolean {
    return true; // Lazy session init
  }
}
