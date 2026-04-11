/**
 * HiBid marketplace adapter — thousands of local auction houses.
 *
 * HiBid uses GraphQL at hibid.com/graphql, protected by Cloudflare.
 * We use Playwright to get a session cookie, then reuse it for
 * direct GraphQL calls. Rate limited to 1 req/5s to be polite.
 */

import { log, error } from "@/lib/logger";
import type { IMarketplaceAdapter, RawListing } from "./IMarketplaceAdapter";
import { makeRawListing } from "./IMarketplaceAdapter";

const GRAPHQL_URL = "https://hibid.com/graphql";
const RATE_LIMIT_MS = 5000; // 1 req per 5 seconds
const LOT_SEARCH_QUERY = `
  query LotSearch(
    $pageNumber: Int!, $pageLength: Int!,
    $searchText: String, $status: AuctionLotStatus,
    $sortOrder: AuctionSort, $filter: LotFilter,
    $isArchive: Boolean, $miles: Int,
    $category: CategoryId
  ) {
    lotSearch(input: {
      searchText: $searchText, status: $status,
      sortOrder: $sortOrder, filter: $filter,
      isArchive: $isArchive, miles: $miles,
      category: $category
    }, pageNumber: $pageNumber, pageLength: $pageLength) {
      pagedResults {
        totalCount
        results {
          lotId
          lotNumber
          title
          currentBid
          startBid
          bidCount
          endDate
          imageUrl
          auctionTitle
          auctionId
          description
        }
      }
    }
  }
`;

interface HiBidLot {
  lotId: number;
  title: string;
  currentBid: number;
  startBid: number;
  bidCount: number;
  endDate: string;
  imageUrl: string | null;
  auctionTitle: string;
  auctionId: number;
  description: string | null;
}

export class HiBidAdapter implements IMarketplaceAdapter {
  marketplace_id = "hibid";
  private cookies: string = "";
  private userAgent: string = "";
  private lastCallAt = 0;
  private sessionReady = false;

  discoveryQueries(): string[] {
    return [
      "video games",
      "nintendo",
      "playstation",
      "xbox",
      "sega genesis",
      "pokemon cards",
      "magic the gathering",
      "trading cards",
      "comic books",
      "funko pop",
      "lego",
      "vinyl records",
      "coins collection",
    ];
  }

  async initSession(): Promise<boolean> {
    if (this.sessionReady) return true;

    log("hibid", "initializing Playwright session for Cloudflare bypass");
    try {
      const { chromium } = require("playwright");
      const browser = await chromium.launch({ headless: true });
      const context = await browser.newContext();
      const page = await context.newPage();

      // Navigate to HiBid — Cloudflare will set cookies
      await page.goto("https://hibid.com/search/lots?q=test", {
        waitUntil: "networkidle",
        timeout: 30000,
      });

      // Grab cookies and user agent
      const allCookies = await context.cookies();
      this.cookies = allCookies
        .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
        .join("; ");
      this.userAgent = await page.evaluate(() => navigator.userAgent);

      await browser.close();

      if (this.cookies) {
        this.sessionReady = true;
        log("hibid", `session ready (${allCookies.length} cookies)`);
        return true;
      }

      error("hibid", "no cookies obtained from Playwright session");
      return false;
    } catch (err) {
      error("hibid", "Playwright session failed", err);
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

  private async graphql(operationName: string, variables: Record<string, unknown>, query: string): Promise<unknown> {
    await this.rateLimit();

    const t0 = Date.now();
    const resp = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": this.userAgent || "Mozilla/5.0",
        Cookie: this.cookies,
      },
      body: JSON.stringify({ operationName, variables, query }),
    });

    if (!resp.ok) {
      error("hibid", `GraphQL ${resp.status} elapsed=${Date.now() - t0}ms`);
      if (resp.status === 403) {
        log("hibid", "Cloudflare blocked — session expired, will retry next scan");
        this.sessionReady = false;
      }
      return null;
    }

    const data = await resp.json();
    log("hibid", `GraphQL ${operationName} elapsed=${Date.now() - t0}ms`);
    return (data as { data: unknown }).data;
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
    log("hibid", `searching: "${query}" limit=${limit}`);

    const data = await this.graphql("LotSearch", {
      searchText: query,
      status: "OPEN",
      pageNumber: 1,
      pageLength: limit,
      sortOrder: "NO_ORDER",
      filter: "ALL",
      isArchive: false,
      miles: 50,
    }, LOT_SEARCH_QUERY) as {
      lotSearch?: {
        pagedResults?: { totalCount: number; results: HiBidLot[] };
      };
    } | null;

    if (!data?.lotSearch?.pagedResults) {
      log("hibid", `search "${query}" returned no data`);
      return [];
    }

    const { totalCount, results } = data.lotSearch.pagedResults;
    log("hibid", `search "${query}": ${results.length} lots (${totalCount} total)`);

    let listings = results.map((lot): RawListing =>
      makeRawListing({
        marketplace_id: "hibid",
        listing_id: String(lot.lotId),
        title: lot.title,
        price_usd: lot.currentBid || lot.startBid || 0,
        url: `https://hibid.com/lot/${lot.lotId}`,
        description: lot.description ?? undefined,
        image_url: lot.imageUrl ?? undefined,
        num_bids: lot.bidCount,
        end_time: lot.endDate,
        extra: {
          auction_title: lot.auctionTitle,
          auction_id: lot.auctionId,
          start_bid: lot.startBid,
        },
      }),
    );

    // Filter by max price if set
    if (options.max_price) {
      listings = listings.filter((l) => l.price_usd <= options.max_price!);
    }

    return listings;
  }

  isAvailable(): boolean {
    return true; // Always try — session init is lazy
  }
}
