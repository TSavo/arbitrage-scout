/**
 * Scryfall connector — free MTG card catalog with market prices.
 * Ported from scryfall.py.
 *
 * No auth required. Rate limit: 50-100ms between requests (be polite).
 * Prices sourced from TCGplayer (USD), Cardmarket (EUR), Cardhoarder (tix).
 *
 * Docs: https://scryfall.com/docs/api
 */

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
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS - elapsed));
    }
    this._lastRequest = Date.now();
  }

  private async _get(path: string, params?: Record<string, string>): Promise<Record<string, unknown>> {
    await this._politeDelay();
    const url = params
      ? `${SCRYFALL_API}${path}?${new URLSearchParams(params)}`
      : `${SCRYFALL_API}${path}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "arbitrage-scout-ts/1.0" },
    });
    if (!res.ok) throw new Error(`Scryfall ${res.status}: ${res.statusText}`);
    return (await res.json()) as Record<string, unknown>;
  }

  /** Search Scryfall for cards. Returns raw card objects with prices. */
  async searchCards(query: string, options: { limit?: number } = {}): Promise<ScryfallCard[]> {
    const limit = options.limit ?? 50;
    try {
      const data = await this._get("/cards/search", {
        q: query,
        unique: "cards",
        order: "name",
      });
      const cards = (data.data as ScryfallCard[]) ?? [];
      console.log(`scryfall search ${JSON.stringify(query)} returned ${cards.length} cards`);
      return cards.slice(0, limit);
    } catch (err) {
      console.warn(`scryfall search ${JSON.stringify(query)} failed:`, err);
      return [];
    }
  }

  /**
   * Look up the USD market price for a card by fuzzy name match.
   * Uses Scryfall's /cards/named endpoint with fuzzy matching.
   * Returns the cheapest non-foil USD price, or null.
   */
  async getPrice(cardName: string): Promise<number | null> {
    try {
      const card = await this._get("/cards/named", { fuzzy: cardName });
      const prices = (card.prices as Record<string, string | null>) ?? {};
      const usd = prices.usd;
      return usd != null ? parseFloat(usd) : null;
    } catch (err) {
      console.debug(`scryfall price lookup ${JSON.stringify(cardName)} failed:`, err);
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
    try {
      const data = await this._get("/cards/search", {
        q: `!"${cardName}"`,
        unique: "prints",
        order: "usd",
        dir: "asc",
      });
      const cards = (data.data as ScryfallCard[]) ?? [];
      return cards
        .map((c) => c.prices?.usd)
        .filter((usd): usd is string => usd != null)
        .map(parseFloat);
    } catch (err) {
      console.debug(`scryfall all prices ${JSON.stringify(cardName)} failed:`, err);
      return [];
    }
  }

  /** Look up a single card by its Scryfall UUID. */
  async lookupById(scryfallId: string): Promise<ScryfallProduct | null> {
    try {
      const card = await this._get(`/cards/${scryfallId}`);
      return _cardToProduct(card as ScryfallCard);
    } catch (err) {
      console.warn(`scryfall lookup ${scryfallId} failed:`, err);
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
