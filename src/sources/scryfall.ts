/**
 * Scryfall connector — free MTG card catalog with market prices.
 * Ported from scryfall.py.
 *
 * No auth required. Rate limit: 50-100ms between requests (be polite).
 * Prices sourced from TCGplayer (USD), Cardmarket (EUR), Cardhoarder (tix).
 *
 * Docs: https://scryfall.com/docs/api
 */

import { log, error } from "@/lib/logger";

const SCRYFALL_API = "https://api.scryfall.com";
/** 100ms between requests per Scryfall guidelines */
const REQUEST_DELAY_MS = 100;

export interface ScryfallCard {
  id: string;
  name: string;
  set_name: string;
  prices: {
    usd?: string | null;
    usd_foil?: string | null;
    eur?: string | null;
    tix?: string | null;
  };
  [key: string]: unknown;
}

export interface ScryfallProduct {
  id: string;
  category: "mtg";
  title: string;
  platform: string;
  external_ids: { scryfall: string };
}

export class ScryfallSource {
  private _lastRequest = 0;

  private async _politeDelay(): Promise<void> {
    const elapsed = Date.now() - this._lastRequest;
    if (elapsed < REQUEST_DELAY_MS) {
      const delay = REQUEST_DELAY_MS - elapsed;
      log("scryfall", `rate limit delay ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
    this._lastRequest = Date.now();
  }

  private async _get(path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
    await this._politeDelay();
    const url = params
      ? `${SCRYFALL_API}${path}?${new URLSearchParams(params)}`
      : `${SCRYFALL_API}${path}`;
    const t0 = Date.now();
    const res = await fetch(url, {
      headers: { "User-Agent": "arbitrage-scout-ts/1.0" },
    });
    if (!res.ok) {
      error("scryfall", `GET ${path} → ${res.status} ${res.statusText} (${Date.now() - t0}ms)`);
      throw new Error(`Scryfall ${res.status}: ${res.statusText}`);
    }
    log("scryfall", `GET ${path} elapsed=${Date.now() - t0}ms`);
    return (await res.json()) as Record<string, unknown>;
  }

  /** Search Scryfall for cards. Returns raw card objects with prices. */
  async searchCards(query: string, options: { limit?: number } = {}): Promise<ScryfallCard[]> {
    const limit = options.limit ?? 50;
    log("scryfall", `searchCards query=${JSON.stringify(query)} limit=${limit}`);
    try {
      const data = await this._get("/cards/search", {
        q: query,
        unique: "cards",
        order: "name",
      });
      const cards = (data.data as ScryfallCard[]) ?? [];
      log("scryfall", `searchCards "${query}" → ${Math.min(cards.length, limit)} cards (${cards.length} total)`);
      return cards.slice(0, limit);
    } catch (err) {
      error("scryfall", `searchCards ${JSON.stringify(query)} failed`, err);
      return [];
    }
  }

  /**
   * Look up the USD market price for a card by fuzzy name match.
   * Uses Scryfall's /cards/named endpoint with fuzzy matching.
   * Returns the cheapest non-foil USD price, or null.
   */
  async getPrice(cardName: string): Promise<number | null> {
    log("scryfall", `getPrice cardName=${JSON.stringify(cardName)}`);
    try {
      const card = await this._get("/cards/named", { fuzzy: cardName });
      const prices = (card.prices as Record<string, string | null>) ?? {};
      const usd = prices.usd;
      const result = usd != null ? parseFloat(usd) : null;
      log("scryfall", `getPrice "${cardName}" → ${result != null ? `$${result}` : "not found"}`);
      return result;
    } catch (err) {
      error("scryfall", `getPrice ${JSON.stringify(cardName)} failed`, err);
      return null;
    }
  }

  /**
   * Get USD prices across all printings of a card.
   *
   * Useful for building comps — shows the range of prices for
   * different editions of the same card.
   */
  async getAllPrices(cardName: string): Promise<number[]> {
    log("scryfall", `getAllPrices cardName=${JSON.stringify(cardName)}`);
    try {
      const data = await this._get("/cards/search", {
        q: `!"${cardName}"`,
        unique: "prints",
        order: "usd",
        dir: "asc",
      });
      const cards = (data.data as ScryfallCard[]) ?? [];
      const prices = cards
        .map((c) => c.prices?.usd)
        .filter((usd): usd is string => usd != null)
        .map(parseFloat);
      log("scryfall", `getAllPrices "${cardName}" → ${prices.length} price points across ${cards.length} printings`);
      return prices;
    } catch (err) {
      error("scryfall", `getAllPrices ${JSON.stringify(cardName)} failed`, err);
      return [];
    }
  }

  /** Look up a single card by its Scryfall UUID. */
  async lookupById(scryfallId: string): Promise<ScryfallProduct | null> {
    log("scryfall", `lookupById scryfallId=${scryfallId}`);
    try {
      const card = await this._get(`/cards/${scryfallId}`);
      const product = _cardToProduct(card as ScryfallCard);
      log("scryfall", `lookupById ${scryfallId} → ${product ? product.title : "null"}`);
      return product;
    } catch (err) {
      error("scryfall", `lookupById ${scryfallId} failed`, err);
      return null;
    }
  }
}

function _cardToProduct(card: ScryfallCard): ScryfallProduct | null {
  try {
    const scryfallId = card.id ?? "";
    return {
      id: `mtg-${scryfallId.slice(0, 12)}`,
      category: "mtg",
      title: card.name ?? "",
      platform: card.set_name ?? "",
      external_ids: { scryfall: scryfallId },
    };
  } catch {
    return null;
  }
}
