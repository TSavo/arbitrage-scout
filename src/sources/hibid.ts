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
import { cachedFetch } from "@/lib/cached_fetch";
import { withSharedPage } from "@/lib/shared_browser";

const GRAPHQL_URL = "https://hibid.com/graphql";
const RATE_LIMIT_MS = 5000; // 1 req per 5 seconds
// Exact query captured from HiBid's frontend via Playwright interception
const LOT_SEARCH_QUERY = `query LotSearch($auctionId: Int = null, $pageNumber: Int!, $pageLength: Int!, $category: CategoryId = null, $searchText: String = null, $zip: String = null, $miles: Int = null, $shippingOffered: Boolean = false, $countryName: String = null, $state: String = null, $status: AuctionLotStatus = null, $sortOrder: EventItemSortOrder = null, $filter: AuctionLotFilter = null, $isArchive: Boolean = false, $dateStart: DateTime, $dateEnd: DateTime, $countAsView: Boolean = true, $hideGoogle: Boolean = false) {
  lotSearch(
    input: {auctionId: $auctionId, category: $category, searchText: $searchText, zip: $zip, miles: $miles, shippingOffered: $shippingOffered, countryName: $countryName, state: $state, status: $status, sortOrder: $sortOrder, filter: $filter, isArchive: $isArchive, dateStart: $dateStart, dateEnd: $dateEnd, countAsView: $countAsView, hideGoogle: $hideGoogle}
    pageNumber: $pageNumber
    pageLength: $pageLength
    sortDirection: DESC
  ) {
    pagedResults {
      totalCount
      results {
        id
        itemId
        lead
        description
        lotNumber
        quantity
        shippingOffered
        featuredPicture {
          thumbnailLocation
          fullSizeLocation
          __typename
        }
        lotState {
          bidCount
          highBid
          buyNow
          minBid
          isClosed
          isLive
          status
          timeLeft
          timeLeftSeconds
          __typename
        }
        auction {
          id
          eventName
          eventCity
          eventState
          __typename
        }
        site {
          domain
          __typename
        }
        __typename
      }
      __typename
    }
    __typename
  }
}`;

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
      return await withSharedPage(async (page) => {
        const context = page.context();

        // Navigate to HiBid — Cloudflare will set cookies
        await page.goto("https://hibid.com/search/lots?q=test", {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });

        // Grab cookies and user agent
        const allCookies = await context.cookies();
        this.cookies = allCookies
          .map((c: { name: string; value: string }) => `${c.name}=${c.value}`)
          .join("; ");
        this.userAgent = await page.evaluate(() => navigator.userAgent);

        if (this.cookies) {
          this.sessionReady = true;
          log("hibid", `session ready (${allCookies.length} cookies)`);
          return true;
        }

        error("hibid", "no cookies obtained from Playwright session");
        return false;
      });
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
    const resp = await cachedFetch(GRAPHQL_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": this.userAgent || "Mozilla/5.0",
        Cookie: this.cookies,
      },
      body: JSON.stringify({ operationName, variables, query }),
    }, {
      ttlMs: 10 * 60 * 1000,
      cacheTag: "hibid-search",
    });

    if (!resp.ok) {
      error("hibid", `GraphQL ${resp.status} elapsed=${Date.now() - t0}ms`);
      if (resp.status === 403) {
        log("hibid", "Cloudflare blocked — session expired, will retry next scan");
        this.sessionReady = false;
      }
      return null;
    }

    const data = resp.json();
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
      auctionId: null,
      category: null,
      searchText: query,
      zip: "",
      miles: 50,
      shippingOffered: false,
      countryName: null,
      state: "",
      status: "OPEN",
      sortOrder: "NO_ORDER",
      filter: "ALL",
      isArchive: false,
      countAsView: false,
      hideGoogle: false,
      pageNumber: 1,
      pageLength: limit,
    }, LOT_SEARCH_QUERY) as {
      lotSearch?: {
        pagedResults?: { totalCount: number; results: any[] };
      };
    } | null;

    if (!data?.lotSearch?.pagedResults) {
      log("hibid", `search "${query}" returned no data`);
      return [];
    }

    const { totalCount, results } = data.lotSearch.pagedResults;
    log("hibid", `search "${query}": ${results.length} lots (${totalCount} total)`);

    // Filter out closed lots and garbled titles before processing
    const activeLots = results.filter((lot) => {
      const lotState = lot.lotState || {};
      const title = (lot.lead || "").trim();
      // Skip closed auctions — their lot IDs get recycled
      if (lotState.isClosed) return false;
      // Skip garbled/empty titles
      if (!title || title.length < 3 || title.startsWith(".")) return false;
      return true;
    });

    if (activeLots.length < results.length) {
      log("hibid", `filtered ${results.length - activeLots.length} closed/invalid lots (${activeLots.length} remain)`);
    }

    let listings = activeLots.map((lot): RawListing => {
      const lotState = lot.lotState || {};
      const auction = lot.auction || {};
      const pic = lot.featuredPicture || {};
      const site = lot.site || {};

      const itemId = lot.itemId || lot.id;
      const auctionId = auction.id;
      const url = `https://hibid.com/lot/${itemId}`;

      return makeRawListing({
        marketplace_id: "hibid",
        listing_id: String(itemId),
        title: lot.lead || "",
        price_usd: lotState.highBid || lotState.minBid || 0,
        url,
        description: lot.description ?? undefined,
        image_url: pic.thumbnailLocation ?? undefined,
        num_bids: lotState.bidCount || 0,
        end_time: lotState.timeLeft ?? undefined,
        extra: {
          auction_id: auctionId,
          auction_name: auction.eventName,
          auction_city: auction.eventCity,
          auction_state: auction.eventState,
          site_domain: site.domain,
          buy_now: lotState.buyNow,
          quantity: lot.quantity,
          shipping_offered: lot.shippingOffered,
        },
      });
    });

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
