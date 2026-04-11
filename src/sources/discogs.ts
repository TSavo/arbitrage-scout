/**
 * Discogs adapter — vinyl records pricing and marketplace discovery.
 *
 * DiscogsSource: catalog/pricing source (like Scryfall for MTG).
 * DiscogsAdapter: IMarketplaceAdapter stub for discovery queries.
 *   Discogs marketplace search requires auth, so search() returns empty;
 *   this adapter exists so the pipeline can generate discovery queries
 *   and route them to other marketplaces (eBay, ShopGoodwill, etc.).
 *
 * API: https://api.discogs.com
 * Auth: none required (User-Agent header mandatory)
 * Rate limit: 25 req/min unauthenticated → 2.5s between calls
 */

import { IMarketplaceAdapter, RawListing } from "./IMarketplaceAdapter";
import { log, error } from "@/lib/logger";

const DISCOGS_BASE = "https://api.discogs.com";
const USER_AGENT = "arbitrage-scout-ts/1.0 +https://github.com/wopr-network/arbitrage-scout-ts";
/** 25 req/min = 1 per 2.4s; use 2.5s for headroom */
const RATE_LIMIT_MS = 2500;

// ── Types ─────────────────────────────────────────────────────────────

export interface DiscogsRelease {
  id: number;
  title: string;
  year: number | null;
  genres: string[];
  /** Lowest current marketplace price in USD, null if no active listings */
  lowest_price: number | null;
  /** Number of active marketplace listings */
  num_for_sale: number;
  /** Community "have" count */
  have: number;
  /** Community "want" count */
  want: number;
}

export interface DiscogsReleaseDetail extends DiscogsRelease {
  artists: string[];
  labels: string[];
  formats: string[];
  country: string | null;
  notes: string | null;
  thumb: string | null;
  uri: string;
}

export interface DiscogsSearchResult {
  id: number;
  title: string;
  year: string | null;
  genres: string[];
  lowest_price: number | null;
  num_for_sale: number;
  have: number;
  want: number;
}

// ── Rate limiter ──────────────────────────────────────────────────────

let _lastCallAt = 0;

async function _rateLimit(): Promise<void> {
  const now = Date.now();
  const wait = RATE_LIMIT_MS - (now - _lastCallAt);
  if (wait > 0) {
    log("discogs", `rate limit: waiting ${wait}ms`);
    await new Promise((r) => setTimeout(r, wait));
  }
  _lastCallAt = Date.now();
}

// ── Low-level HTTP ────────────────────────────────────────────────────

async function _get(path: string): Promise<Record<string, unknown>> {
  await _rateLimit();
  const url = `${DISCOGS_BASE}${path}`;
  const t0 = Date.now();
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/vnd.discogs.v2.discogs+json",
    },
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} from ${url}`);
  }
  const data = (await res.json()) as Record<string, unknown>;
  log("discogs", `GET ${path} elapsed=${Date.now() - t0}ms`);
  return data;
}

// ── DiscogsSource (catalog + pricing) ────────────────────────────────

export class DiscogsSource {
  /**
   * Search Discogs database for releases.
   *
   * @param query  Free-text search string
   * @param limit  Max results (default 25, max 100 per page)
   */
  async searchReleases(query: string, limit = 25): Promise<DiscogsSearchResult[]> {
    log("discogs", `searchReleases query=${JSON.stringify(query)} limit=${limit}`);
    try {
      const perPage = Math.min(limit, 100);
      const data = await _get(
        `/database/search?q=${encodeURIComponent(query)}&type=release&per_page=${perPage}&page=1`,
      );
      const results = (data.results as Record<string, unknown>[]) ?? [];
      const parsed = results.slice(0, limit).map(_parseSearchResult);
      log("discogs", `searchReleases "${query}" → ${parsed.length} results`);
      return parsed;
    } catch (err) {
      error("discogs", `searchReleases "${query}" failed`, err);
      return [];
    }
  }

  /**
   * Get full release details including current pricing.
   */
  async getRelease(id: number): Promise<DiscogsReleaseDetail | null> {
    log("discogs", `getRelease id=${id}`);
    try {
      const data = await _get(`/releases/${id}`);
      return _parseReleaseDetail(data);
    } catch (err) {
      error("discogs", `getRelease id=${id} failed`, err);
      return null;
    }
  }

  /**
   * Get just the lowest active marketplace price for a release.
   * Returns null if no listings or price unavailable.
   */
  async getLowestPrice(id: number): Promise<number | null> {
    log("discogs", `getLowestPrice id=${id}`);
    try {
      const data = await _get(`/releases/${id}`);
      const price = (data.lowest_price as number | null) ?? null;
      const numForSale = (data.num_for_sale as number) ?? 0;
      log(
        "discogs",
        `getLowestPrice id=${id} lowest_price=${price ?? "null"} num_for_sale=${numForSale}`,
      );
      return price;
    } catch (err) {
      error("discogs", `getLowestPrice id=${id} failed`, err);
      return null;
    }
  }
}

// ── Parsers ───────────────────────────────────────────────────────────

function _parseSearchResult(raw: Record<string, unknown>): DiscogsSearchResult {
  const community = (raw.community as Record<string, unknown>) ?? {};
  return {
    id: (raw.id as number) ?? 0,
    title: (raw.title as string) ?? "",
    year: (raw.year as string | null) ?? null,
    genres: (raw.genre as string[]) ?? [],
    lowest_price: (raw.lowest_price as number | null) ?? null,
    num_for_sale: (raw.num_for_sale as number) ?? 0,
    have: (community.have as number) ?? 0,
    want: (community.want as number) ?? 0,
  };
}

function _parseReleaseDetail(raw: Record<string, unknown>): DiscogsReleaseDetail {
  const community = (raw.community as Record<string, unknown>) ?? {};
  const have = ((community.have as number) ?? (community.in_collection as number) ?? 0);
  const want = ((community.want as number) ?? (community.in_wantlist as number) ?? 0);

  const artists = ((raw.artists as Record<string, unknown>[]) ?? [])
    .map((a) => (a.name as string) ?? "")
    .filter(Boolean);

  const labels = ((raw.labels as Record<string, unknown>[]) ?? [])
    .map((l) => (l.name as string) ?? "")
    .filter(Boolean);

  const formats = ((raw.formats as Record<string, unknown>[]) ?? [])
    .map((f) => (f.name as string) ?? "")
    .filter(Boolean);

  return {
    id: (raw.id as number) ?? 0,
    title: (raw.title as string) ?? "",
    year: (raw.year as number | null) ?? null,
    genres: (raw.genres as string[]) ?? [],
    lowest_price: (raw.lowest_price as number | null) ?? null,
    num_for_sale: (raw.num_for_sale as number) ?? 0,
    have,
    want,
    artists,
    labels,
    formats,
    country: (raw.country as string | null) ?? null,
    notes: (raw.notes as string | null) ?? null,
    thumb: (raw.thumb as string | null) ?? null,
    uri: (raw.uri as string) ?? `https://www.discogs.com/release/${raw.id ?? ""}`,
  };
}

// ── DiscogsAdapter (IMarketplaceAdapter) ─────────────────────────────

/**
 * Discogs marketplace adapter for discovery query generation.
 *
 * Discogs marketplace search requires OAuth authentication, so search()
 * returns empty. This adapter provides discovery queries so the pipeline
 * knows to look for vinyl records on eBay, ShopGoodwill, and Mercari.
 * Pricing is handled by DiscogsSource (lowest_price from release data).
 */
export class DiscogsAdapter implements IMarketplaceAdapter {
  readonly marketplace_id = "discogs";

  discoveryQueries(): string[] {
    return [
      "vinyl records",
      "vinyl lot",
      "record collection",
      "vinyl albums",
      "LP records",
      "vinyl record lot",
    ];
  }

  /**
   * Discogs marketplace search requires OAuth — not available unauthenticated.
   * Returns empty; this adapter is for pricing (via DiscogsSource), not buying.
   */
  async search(
    _query: string,
    _options?: { max_price?: number; limit?: number },
  ): Promise<RawListing[]> {
    log(
      "discogs",
      "search() not available (Discogs marketplace requires auth); use DiscogsSource for pricing",
    );
    return [];
  }

  isAvailable(): boolean {
    return true;
  }
}
