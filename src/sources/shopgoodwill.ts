/**
 * ShopGoodwill adapter — Goodwill online auctions.
 * Ported from shopgoodwill.py + shopgoodwill_adapter.py.
 *
 * Auth: AES-CBC encrypted credentials POSTed to SignIn/Login,
 *       returns a Bearer JWT used for all subsequent calls.
 * API: buyerapi.shopgoodwill.com
 */

import { createCipheriv, createHash } from "crypto";
import { IMarketplaceAdapter, RawListing, makeRawListing } from "./IMarketplaceAdapter";

const API_ROOT = "https://buyerapi.shopgoodwill.com/api";

// These are the public client-side encryption constants ShopGoodwill bakes
// into their web app JS. They are not secret — they ship them to every browser.
const ENCRYPTION_KEY = Buffer.from("6696D2E6F042FEC4D6E3F32AD541143B");
const ENCRYPTION_IV = Buffer.from("0000000000000000");

export interface ShopGoodwillConfig {
  username: string;
  password: string;
}

export interface GoodwillItem {
  item_id: number;
  title: string;
  current_price: number;
  num_bids: number;
  end_time: string;
  url: string;
  image_url?: string;
  seller?: string;
  buy_now_price?: number;
}

// ------------------------------------------------------------
// AES-CBC encryption (mirrors Python PyCryptodome implementation)
// ------------------------------------------------------------

function pkcs7Pad(buf: Buffer, blockSize: number): Buffer {
  const padLen = blockSize - (buf.length % blockSize);
  const padding = Buffer.alloc(padLen, padLen);
  return Buffer.concat([buf, padding]);
}

function encrypt(plaintext: string): string {
  const padded = pkcs7Pad(Buffer.from(plaintext, "utf8"), 16);
  const cipher = createCipheriv("aes-256-cbc", ENCRYPTION_KEY, ENCRYPTION_IV);
  cipher.setAutoPadding(false); // we padded manually
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);
  return encodeURIComponent(encrypted.toString("base64"));
}

// ------------------------------------------------------------
// Low-level ShopGoodwill source
// ------------------------------------------------------------

class ShopGoodwillSource {
  private _token: string | null = null;
  private readonly _username: string;
  private readonly _password: string;

  constructor(cfg: ShopGoodwillConfig) {
    this._username = cfg.username;
    this._password = cfg.password;
  }

  async login(): Promise<boolean> {
    try {
      const res = await fetch(`${API_ROOT}/SignIn/Login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0",
        },
        body: JSON.stringify({
          username: encrypt(this._username),
          password: encrypt(this._password),
          remember: false,
        }),
      });

      const data = (await res.json()) as Record<string, unknown>;
      if (data.status && data.accessToken) {
        this._token = data.accessToken as string;
        console.log("shopgoodwill login successful");
        return true;
      }
      console.warn(`shopgoodwill login failed: ${data.message}`);
      return false;
    } catch (err) {
      console.warn("shopgoodwill login error:", err);
      return false;
    }
  }

  async search(
    query: string,
    options: { page_size?: number; max_price?: number } = {},
  ): Promise<GoodwillItem[]> {
    if (!this._token) {
      if (!(await this.login())) return [];
    }

    const pageSize = options.page_size ?? 40;
    const maxPrice = options.max_price ?? 999999;

    const params = {
      searchText: query,
      searchDescriptions: true,
      sortColumn: 1,
      sortDescending: false,
      categoryId: -1,
      sellerIds: "",
      closedAuctionEndingDate: "",
      closedAuctionDaysBack: 0,
      searchBuyNowOnly: false,
      lowPrice: 0,
      highPrice: maxPrice,
      searchCanada498: false,
      itemTypeIds: "",
      savedSearchId: 0,
      useBuyerPrefs: true,
      searchUSOnly: false,
      pageNumber: 1,
      pageSize,
    };

    try {
      const res = await fetch(`${API_ROOT}/Search/ItemListing`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0",
          Authorization: `Bearer ${this._token}`,
        },
        body: JSON.stringify(params),
      });

      const data = (await res.json()) as Record<string, unknown>;
      const items = ((data.searchResults as Record<string, unknown>)?.items as Record<string, unknown>[]) ?? [];
      console.log(`shopgoodwill search ${JSON.stringify(query)} → ${items.length} items`);
      return items.map(_parseItem).filter((x): x is GoodwillItem => x !== null);
    } catch (err) {
      console.warn(`shopgoodwill search ${JSON.stringify(query)} failed:`, err);
      return [];
    }
  }
}

function _parseItem(raw: Record<string, unknown>): GoodwillItem | null {
  try {
    const itemId = (raw.itemId as number | undefined) ?? 0;
    const buyNowRaw = parseFloat(String(raw.buyNowPrice ?? 0));
    return {
      item_id: itemId,
      title: (raw.title as string | undefined) ?? "",
      current_price: parseFloat(String(raw.currentPrice ?? 0)),
      num_bids: (raw.numBids as number | undefined) ?? 0,
      end_time: (raw.endTime as string | undefined) ?? "",
      url: `https://shopgoodwill.com/item/${itemId}`,
      image_url: raw.imageURL as string | undefined,
      seller: raw.sellerName as string | undefined,
      buy_now_price: buyNowRaw > 0 ? buyNowRaw : undefined,
    };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// IMarketplaceAdapter
// ------------------------------------------------------------

export class ShopGoodwillAdapter implements IMarketplaceAdapter {
  readonly marketplace_id = "shopgoodwill";

  private readonly _sgw: ShopGoodwillSource;
  private _loggedIn = false;

  constructor(cfg: ShopGoodwillConfig) {
    this._sgw = new ShopGoodwillSource(cfg);
  }

  discoveryQueries(): string[] {
    return [
      "video games",
      "nintendo",
      "playstation",
      "xbox",
      "sega",
      "pokemon cards",
      "magic the gathering cards",
      "trading cards",
      "n64",
      "snes",
      "gamecube",
      "gameboy",
      "game boy",
      "retro games",
      "vintage games",
    ];
  }

  async search(
    query: string,
    options: { max_price?: number; limit?: number } = {},
  ): Promise<RawListing[]> {
    if (!this._loggedIn) {
      this._loggedIn = await this._sgw.login();
      if (!this._loggedIn) return [];
    }

    const items = await this._sgw.search(query, {
      page_size: options.limit ?? 40,
      max_price: options.max_price,
    });

    return items.map((i) =>
      makeRawListing({
        marketplace_id: "shopgoodwill",
        listing_id: String(i.item_id),
        title: i.title,
        price_usd: i.current_price,
        url: i.url,
        image_url: i.image_url,
        seller: i.seller,
        num_bids: i.num_bids,
        end_time: i.end_time,
        extra: { buy_now_price: i.buy_now_price },
      }),
    );
  }

  isAvailable(): boolean {
    return true;
  }
}
