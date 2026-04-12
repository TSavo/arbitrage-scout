/**
 * Whatnot marketplace adapter — live auctions and buy-now collectibles.
 *
 * Whatnot uses GraphQL at api.whatnot.com/graphql/, behind Cloudflare.
 * The searchProducts query requires an authenticated session to return results.
 *
 * We use Playwright to:
 * 1. Navigate to whatnot.com, bypassing Cloudflare
 * 2. Intercept GraphQL requests to capture the auth token and query format
 * 3. Replay those for subsequent searches via fetch()
 *
 * Known GraphQL schema (discovered via probing):
 *   searchProducts(query: String!, size: Int, page: Int, filters: JSONString, sortBy: String)
 *     -> ProductSearchResultNode { hits: [ProductSearchNode { id, name, slug, image { url }, tags }] }
 *
 * Rate limited to 1 req per 2 seconds minimum.
 */

import { log, error } from "@/lib/logger";
import type { IMarketplaceAdapter, RawListing } from "./IMarketplaceAdapter";
import { makeRawListing } from "./IMarketplaceAdapter";
import { cachedFetch } from "@/lib/cached_fetch";
import { withSharedPage } from "@/lib/shared_browser";

const GRAPHQL_URL = "https://api.whatnot.com/graphql/";
const RATE_LIMIT_MS = 2000;
const SESSION_MAX_AGE_MS = 20 * 60 * 1000; // 20 minutes
const DEFAULT_LIMIT = 40;
const MAX_SIZE = 100;

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * The minimal GraphQL query for product search.
 * Discovered by probing the schema — only these fields are confirmed
 * to exist on ProductSearchNode without auth errors.
 */
const SEARCH_PRODUCTS_QUERY = `query SearchProducts($query: String!, $size: Int, $page: Int, $filters: JSONString, $sortBy: String) {
  searchProducts(query: $query, size: $size, page: $page, filters: $filters, sortBy: $sortBy) {
    hits {
      id
      name
      slug
      image {
        url
      }
      tags
    }
  }
}`;

/**
 * Extended query captured from Playwright interception.
 * This gets populated at runtime with whatever fields the real frontend uses.
 */
interface CapturedGraphQLQuery {
  operationName: string;
  query: string;
  /** Template variables — we swap `query` at search time */
  variables: Record<string, unknown>;
}

interface WhatnotSession {
  cookies: string;
  userAgent: string;
  authToken: string | null;
  capturedSearch: CapturedGraphQLQuery | null;
}

export class WhatnotAdapter implements IMarketplaceAdapter {
  marketplace_id = "whatnot";

  private session: WhatnotSession | null = null;
  private lastCallAt = 0;
  private sessionReady = false;
  private sessionInitAt = 0;

  discoveryQueries(): string[] {
    return [
      "pokemon cards",
      "magic the gathering",
      "sports cards",
      "funko pop",
      "yu-gi-oh cards",
      "one piece cards",
      "comic books",
      "lego",
      "coins",
      "vinyl records",
      "video games",
    ];
  }

  isAvailable(): boolean {
    return true; // Lazy session init
  }

  /**
   * Launch Playwright, navigate to Whatnot search, and intercept
   * the GraphQL auth token + search query format.
   */
  async initSession(): Promise<boolean> {
    if (this.sessionReady && Date.now() - this.sessionInitAt < SESSION_MAX_AGE_MS) {
      return true;
    }

    this.sessionReady = false;
    this.session = null;

    log("whatnot", `initializing Playwright session (shared headed Chrome)`);
    try {
      return await withSharedPage(async (page) => {
        const context = page.context();

      let authToken: string | null = null;
      let capturedSearch: CapturedGraphQLQuery | null = null;

      // Intercept all requests to capture GraphQL auth and search queries
      page.on(
        "request",
        (req: {
          url: () => string;
          method: () => string;
          headers: () => Record<string, string>;
          postData: () => string | null;
        }) => {
          const url = req.url();
          if (!url.includes("whatnot.com") || req.method() !== "POST") return;

          // Capture auth token from any GraphQL request
          const headers = req.headers();
          const auth = headers["authorization"] || headers["Authorization"];
          if (auth && auth.startsWith("Bearer ") && !authToken) {
            authToken = auth.replace("Bearer ", "");
            log("whatnot", "captured auth token from request headers");
          }

          // Capture search-related GraphQL operations
          if (url.includes("graphql")) {
            const postData = req.postData();
            if (postData) {
              try {
                const body = JSON.parse(postData);
                const opName = (body.operationName || "").toLowerCase();
                if (
                  opName.includes("search") ||
                  opName.includes("product") ||
                  opName.includes("browse") ||
                  opName.includes("listing") ||
                  opName.includes("discover")
                ) {
                  log("whatnot", `captured GraphQL operation: ${body.operationName}`);
                  // Prefer search-related operations
                  if (
                    !capturedSearch ||
                    opName.includes("search")
                  ) {
                    capturedSearch = {
                      operationName: body.operationName,
                      query: body.query,
                      variables: body.variables || {},
                    };
                  }
                }
              } catch {
                // Not JSON, skip
              }
            }
          }
        },
      );

      // Navigate to search page to trigger GraphQL calls
      log("whatnot", "navigating to whatnot.com/search");
      await page.goto("https://www.whatnot.com/search?q=pokemon+cards", {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });

      // Wait for deferred API calls
      await page.waitForTimeout(3000);

      // If no search was captured, try browsing a category page
      if (!capturedSearch) {
        log("whatnot", "no search query captured, trying category page");
        await page.goto("https://www.whatnot.com/category/pokemon-cards", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForTimeout(3000);
      }

      // Grab cookies
      const allCookies = await context.cookies();
      const cookies = allCookies
        .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
        .join("; ");
      const userAgent = await page.evaluate(() => navigator.userAgent);

      this.session = {
        cookies,
        userAgent,
        authToken,
        capturedSearch,
      };

      if (authToken || cookies) {
        this.sessionReady = true;
        this.sessionInitAt = Date.now();
        log(
          "whatnot",
          `session ready — auth=${!!authToken} captured=${!!capturedSearch} cookies=${allCookies.length}`,
        );
        return true;
      }

      error("whatnot", "no auth token or cookies obtained from Playwright session");
      return false;
      });
    } catch (err) {
      error("whatnot", "Playwright session failed", err);
      return false;
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

    const limit = Math.min(options.limit ?? DEFAULT_LIMIT, MAX_SIZE);
    log("whatnot", `searching: "${query}" limit=${limit}`);

    // Try the captured search query first (exact frontend format)
    if (this.session?.capturedSearch) {
      const results = await this.searchViaCapturedQuery(query, limit, options.max_price);
      if (results.length > 0) {
        log("whatnot", `search "${query}": ${results.length} results via captured query`);
        return results;
      }
      log("whatnot", "captured query returned no results, falling back to known schema");
    }

    // Fall back to our known searchProducts query
    const results = await this.searchViaKnownQuery(query, limit, options.max_price);
    if (results.length > 0) {
      log("whatnot", `search "${query}": ${results.length} results via known query`);
      return results;
    }

    // Final fallback: Playwright HTML scraping
    const htmlResults = await this.searchViaHtml(query, limit, options.max_price);
    log("whatnot", `search "${query}": ${htmlResults.length} results via HTML fallback`);
    return htmlResults;
  }

  /**
   * Search using the query format captured from the frontend.
   */
  private async searchViaCapturedQuery(
    query: string,
    limit: number,
    maxPrice?: number,
  ): Promise<RawListing[]> {
    if (!this.session?.capturedSearch) return [];

    await this.rateLimit();

    const captured = this.session.capturedSearch;
    const variables = { ...captured.variables };

    // Inject our search query into the variables
    this.injectSearchQuery(variables, query);

    // Inject size/limit
    if ("size" in variables) variables.size = limit;
    if ("first" in variables) variables.first = limit;
    if ("limit" in variables) variables.limit = limit;

    const data = await this.graphql(
      captured.operationName,
      variables,
      captured.query,
    );

    if (!data) return [];

    // Parse whatever shape the response has
    const items = this.findProductArray(data);
    if (!items || items.length === 0) return [];

    return this.mapToListings(items, limit, maxPrice);
  }

  /**
   * Search using the known searchProducts schema.
   */
  private async searchViaKnownQuery(
    query: string,
    limit: number,
    maxPrice?: number,
  ): Promise<RawListing[]> {
    await this.rateLimit();

    const filters: Record<string, string[]> = {};
    if (maxPrice) {
      filters.prices = [`0-${Math.ceil(maxPrice * 100)}`];
    }
    // Request in-stock items when available
    filters.in_stock = ["true"];

    const variables: Record<string, unknown> = {
      query,
      size: limit,
      page: 0,
      filters: JSON.stringify(filters),
    };

    const data = (await this.graphql(
      "SearchProducts",
      variables,
      SEARCH_PRODUCTS_QUERY,
    )) as {
      searchProducts?: {
        hits?: Array<{
          id: string;
          name: string;
          slug?: string;
          image?: { url?: string };
          tags?: string[];
        }>;
      };
    } | null;

    if (!data?.searchProducts?.hits?.length) return [];

    const hits = data.searchProducts.hits;
    log("whatnot", `known query returned ${hits.length} hits`);

    let listings = hits
      .filter((h) => h.id && h.name)
      .map((h): RawListing => {
        const productUrl = h.slug
          ? `https://www.whatnot.com/product/${h.slug}`
          : `https://www.whatnot.com/product/${h.id}`;

        return makeRawListing({
          marketplace_id: "whatnot",
          listing_id: h.id,
          title: h.name,
          price_usd: 0, // Price not available from search — filled by detail lookups
          url: productUrl,
          image_url: h.image?.url ?? undefined,
          extra: {
            slug: h.slug,
            tags: h.tags,
            needs_price_lookup: true,
          },
        });
      });

    // Filter out $0 / negative price listings
    listings = listings.filter((l) => l.price_usd > 0);

    if (maxPrice) {
      listings = listings.filter(
        (l) => l.price_usd + l.shipping_usd <= maxPrice,
      );
    }

    return listings.slice(0, limit);
  }

  /**
   * Fallback: use Playwright to load the search page and scrape results from HTML.
   */
  private async searchViaHtml(
    query: string,
    limit: number,
    maxPrice?: number,
  ): Promise<RawListing[]> {
    await this.rateLimit();

    const encodedQuery = encodeURIComponent(query);
    const searchUrl = `https://www.whatnot.com/search?q=${encodedQuery}`;

    log("whatnot", `HTML fallback: loading ${searchUrl}`);

    try {
      return await withSharedPage(async (page) => {
      // Collect GraphQL responses during page load
      // eslint-disable-next-line prefer-const
      let apiItems: Record<string, unknown>[] | null = null as Record<string, unknown>[] | null;
      page.on(
        "response",
        async (resp: {
          url: () => string;
          status: () => number;
          text: () => Promise<string>;
        }) => {
          const url = resp.url();
          if (
            url.includes("whatnot.com") &&
            url.includes("graphql") &&
            resp.status() === 200
          ) {
            try {
              const text = await resp.text();
              const json = JSON.parse(text);
              const found = this.findProductArray(json);
              if (found && found.length > 0) {
                apiItems = found;
                log(
                  "whatnot",
                  `HTML fallback: intercepted ${found.length} items from GraphQL response`,
                );
              }
            } catch {
              // skip
            }
          }
        },
      );

      await page.goto(searchUrl, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await page.waitForTimeout(3000);

      // If we intercepted API items, use those
      if (apiItems && apiItems.length > 0) {
        return this.mapToListings(apiItems, limit, maxPrice);
      }

      // Otherwise, parse HTML
      const listings: RawListing[] = [];

      // Whatnot renders product cards — try multiple selectors
      const selectors = [
        'a[href*="/product/"]',
        '[data-testid*="product"]',
        '[data-testid*="listing"]',
        '[class*="ProductCard"]',
        '[class*="productCard"]',
        '[class*="ListingCard"]',
        '[class*="listingCard"]',
        '[class*="ItemCard"]',
        '[class*="itemCard"]',
      ];

      let itemElements: unknown[] = [];
      for (const selector of selectors) {
        const count = await page.locator(selector).count();
        if (count > 0) {
          log(
            "whatnot",
            `HTML fallback: found ${count} items with selector "${selector}"`,
          );
          itemElements = await page.locator(selector).all();
          break;
        }
      }

      if (itemElements.length === 0) {
        log("whatnot", "HTML fallback: no item elements found on page");
        return [];
      }

      for (const el of itemElements.slice(0, limit)) {
        try {
          const itemData = await (
            el as {
              evaluate: (
                fn: (node: HTMLElement) => Record<string, string | null>,
              ) => Promise<Record<string, string | null>>;
            }
          ).evaluate((node: HTMLElement) => {
            const link = node.closest("a") || node.querySelector("a");
            const href = link?.getAttribute("href") || "";
            const img = node.querySelector("img");
            const imgSrc =
              img?.getAttribute("src") || img?.getAttribute("data-src") || "";

            // Find price text
            const priceEl =
              node.querySelector('[class*="rice"]') ||
              node.querySelector('[class*="Price"]') ||
              node.querySelector('[data-testid*="price"]');
            const priceText = priceEl?.textContent || "";

            // Find title text
            const titleEl =
              node.querySelector('[class*="itle"]') ||
              node.querySelector('[class*="name"]') ||
              node.querySelector('[class*="Name"]');
            const titleText =
              titleEl?.textContent || img?.getAttribute("alt") || "";

            // Find seller
            const sellerEl =
              node.querySelector('[class*="eller"]') ||
              node.querySelector('[class*="Seller"]');
            const sellerText = sellerEl?.textContent || "";

            return { href, imgSrc, priceText, titleText, sellerText };
          });

          const href = itemData.href || "";
          const slugMatch = href.match(/\/product\/([^/?]+)/);
          const id = slugMatch ? slugMatch[1] : href;

          if (!id || !itemData.titleText) continue;

          const priceMatch = (itemData.priceText || "").match(
            /\$?([\d,]+(?:\.\d{2})?)/,
          );
          const price = priceMatch
            ? parseFloat(priceMatch[1].replace(/,/g, ""))
            : 0;

          if (maxPrice && price > 0 && price > maxPrice) continue;

          listings.push(
            makeRawListing({
              marketplace_id: "whatnot",
              listing_id: id,
              title: (itemData.titleText || "").trim(),
              price_usd: price,
              url: href.startsWith("http")
                ? href
                : `https://www.whatnot.com${href}`,
              image_url: itemData.imgSrc || undefined,
              seller: itemData.sellerText?.trim() || undefined,
            }),
          );
        } catch {
          // Skip unparseable items
        }
      }

      log("whatnot", `HTML fallback: parsed ${listings.length} listings`);
      return listings;
      });
    } catch (err) {
      error("whatnot", "HTML fallback search failed", err);
      return [];
    }
  }

  /**
   * Execute a GraphQL request against api.whatnot.com.
   */
  private async graphql(
    operationName: string,
    variables: Record<string, unknown>,
    query: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "User-Agent": this.session?.userAgent || USER_AGENT,
      "Apollographql-Client-Name": "web",
      "X-Whatnot-App": "whatnot-web",
    };

    if (this.session?.cookies) {
      headers["Cookie"] = this.session.cookies;
    }
    if (this.session?.authToken) {
      headers["Authorization"] = `Bearer ${this.session.authToken}`;
    }

    const t0 = Date.now();
    try {
      const resp = await cachedFetch(GRAPHQL_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({ operationName, variables, query }),
      }, {
        ttlMs: 10 * 60 * 1000,
        cacheTag: "whatnot-search",
      });

      if (!resp.ok) {
        error("whatnot", `GraphQL ${resp.status} elapsed=${Date.now() - t0}ms`);
        if (resp.status === 403 || resp.status === 401) {
          log("whatnot", "auth expired — will re-init session on next search");
          this.sessionReady = false;
        }
        return null;
      }

      const data = resp.json<{ data?: unknown; errors?: unknown[] }>();
      log("whatnot", `GraphQL ${operationName} elapsed=${Date.now() - t0}ms`);

      if (data.errors) {
        error(
          "whatnot",
          `GraphQL errors for ${operationName}: ${JSON.stringify(data.errors).slice(0, 200)}`,
        );
      }

      return data.data ?? null;
    } catch (err) {
      error("whatnot", `GraphQL ${operationName} failed`, err);
      return null;
    }
  }

  private async rateLimit(): Promise<void> {
    const elapsed = Date.now() - this.lastCallAt;
    if (elapsed < RATE_LIMIT_MS) {
      await new Promise((resolve) =>
        setTimeout(resolve, RATE_LIMIT_MS - elapsed),
      );
    }
    this.lastCallAt = Date.now();
  }

  /**
   * Recursively inject search query into a variables object.
   * Matches common field names from various GraphQL operations.
   */
  private injectSearchQuery(
    obj: Record<string, unknown>,
    searchQuery: string,
  ): void {
    for (const key of Object.keys(obj)) {
      const lk = key.toLowerCase();
      if (
        lk === "query" ||
        lk === "searchquery" ||
        lk === "searchtext" ||
        lk === "keyword" ||
        lk === "q"
      ) {
        obj[key] = searchQuery;
      } else if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
        this.injectSearchQuery(obj[key] as Record<string, unknown>, searchQuery);
      }
    }
  }

  /**
   * Recursively search a response for an array that looks like product results.
   */
  private findProductArray(
    obj: unknown,
    depth = 0,
  ): Record<string, unknown>[] | null {
    if (depth > 10) return null;

    if (Array.isArray(obj)) {
      if (
        obj.length > 0 &&
        typeof obj[0] === "object" &&
        obj[0] !== null &&
        this.looksLikeProduct(obj[0] as Record<string, unknown>)
      ) {
        return obj as Record<string, unknown>[];
      }
    }

    if (typeof obj === "object" && obj !== null) {
      // Prefer keys named "hits", "products", "items", "results", "nodes", "edges"
      const priorityKeys = ["hits", "products", "items", "results", "nodes", "edges", "listings"];
      const entries = Object.entries(obj as Record<string, unknown>);
      const sorted = entries.sort(([a], [b]) => {
        const aIdx = priorityKeys.indexOf(a);
        const bIdx = priorityKeys.indexOf(b);
        if (aIdx >= 0 && bIdx >= 0) return aIdx - bIdx;
        if (aIdx >= 0) return -1;
        if (bIdx >= 0) return 1;
        return 0;
      });

      for (const [, val] of sorted) {
        const found = this.findProductArray(val, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  /**
   * Heuristic: does this object look like a product/listing?
   */
  private looksLikeProduct(obj: Record<string, unknown>): boolean {
    const keys = Object.keys(obj).map((k) => k.toLowerCase());
    const hasId = keys.some(
      (k) => k === "id" || k === "productid" || k === "listingid" || k === "objectid",
    );
    const hasName = keys.some(
      (k) => k === "name" || k === "title" || k === "productname" || k === "lead",
    );
    const hasSlug = keys.some((k) => k === "slug" || k === "url" || k === "permalink");
    const hasImage = keys.some(
      (k) => k === "image" || k === "imageurl" || k === "thumbnail" || k === "photo",
    );
    const hasPrice = keys.some(
      (k) =>
        k === "price" ||
        k === "pricecents" ||
        k === "currentprice" ||
        k === "buynowprice" ||
        k === "lowestprice",
    );

    // At least 2 of these signals
    const signals = [hasId, hasName, hasSlug, hasImage, hasPrice].filter(Boolean).length;
    return signals >= 2;
  }

  /**
   * Map raw product objects into RawListing[].
   */
  private mapToListings(
    items: Record<string, unknown>[],
    limit: number,
    maxPrice?: number,
  ): RawListing[] {
    let listings = items.slice(0, limit).map((item): RawListing => {
      const id = String(
        item.id || item.productId || item.listingId || item.objectID || "",
      );
      const name = String(
        item.name || item.title || item.productName || "",
      );
      const slug = item.slug ? String(item.slug) : undefined;

      // Price — try various field names and formats
      let price = 0;
      const priceFields = [
        "price",
        "priceCents",
        "currentPrice",
        "buyNowPrice",
        "buyNowPriceCents",
        "lowestPrice",
        "lowestPriceCents",
        "startingPrice",
        "startingBid",
        "currentBid",
      ];
      for (const f of priceFields) {
        if (item[f] !== undefined && item[f] !== null) {
          const raw = Number(item[f]);
          if (!isNaN(raw) && raw > 0) {
            // If field name ends with "Cents", convert to dollars
            price = f.toLowerCase().includes("cents") ? raw / 100 : raw;
            break;
          }
        }
      }

      // Image URL
      let imageUrl: string | undefined;
      if (item.image && typeof item.image === "object") {
        imageUrl = (item.image as Record<string, unknown>).url as string | undefined;
      } else if (typeof item.imageUrl === "string") {
        imageUrl = item.imageUrl;
      } else if (typeof item.thumbnailUrl === "string") {
        imageUrl = item.thumbnailUrl;
      } else if (typeof item.thumbnail === "string") {
        imageUrl = item.thumbnail;
      }

      // Seller
      let seller: string | undefined;
      if (item.seller && typeof item.seller === "object") {
        seller = String(
          (item.seller as Record<string, unknown>).username ||
            (item.seller as Record<string, unknown>).name ||
            "",
        );
      } else if (typeof item.sellerUsername === "string") {
        seller = item.sellerUsername;
      } else if (typeof item.sellerName === "string") {
        seller = item.sellerName;
      }

      // Condition
      const condition = item.condition
        ? String(item.condition)
        : item.conditionDescription
          ? String(item.conditionDescription)
          : undefined;

      // Category
      const category = item.category
        ? typeof item.category === "object"
          ? String((item.category as Record<string, unknown>).name || (item.category as Record<string, unknown>).label || "")
          : String(item.category)
        : undefined;

      // Description
      const description = item.description ? String(item.description) : undefined;

      // Tags
      const tags = Array.isArray(item.tags) ? item.tags : undefined;

      // Listing type (buy-now vs auction)
      const listingType = item.listingType || item.type || item.saleType;

      const productUrl = slug
        ? `https://www.whatnot.com/product/${slug}`
        : `https://www.whatnot.com/product/${id}`;

      return makeRawListing({
        marketplace_id: "whatnot",
        listing_id: id,
        title: name,
        price_usd: price,
        url: productUrl,
        description,
        condition_raw: condition,
        category_raw: category || undefined,
        image_url: imageUrl,
        seller: seller || undefined,
        extra: {
          slug,
          tags,
          listing_type: listingType,
          needs_price_lookup: price === 0,
        },
      });
    });

    // Filter out $0 / negative price listings — Whatnot sometimes returns
    // placeholder prices that would create false opportunities.
    listings = listings.filter((l) => l.price_usd > 0);

    if (maxPrice) {
      listings = listings.filter(
        (l) => l.price_usd + l.shipping_usd <= maxPrice,
      );
    }

    return listings;
  }
}
