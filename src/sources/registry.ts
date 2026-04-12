/**
 * Build all configured marketplace adapters from a config object.
 * Ported from registry.py.
 *
 * Usage:
 *   const adapters = buildAdapters(config);
 */

import { IMarketplaceAdapter } from "./IMarketplaceAdapter";
import { EbayAdapter } from "./ebay";
import { ShopGoodwillAdapter } from "./shopgoodwill";
import { PriceChartingAdapter } from "./pricecharting";
import { DiscogsAdapter } from "./discogs";
import { HiBidAdapter } from "./hibid";
import { TcgPlayerMarketAdapter } from "./tcgplayer_market";
import { MercariAdapter } from "./mercari";
import { LiveAuctioneersAdapter } from "./liveauctioneers";
import { WhatnotAdapter } from "./whatnot";
import { KlwinesAdapter } from "./klwines";
import { BittersAndBottlesAdapter } from "./bittersandbottles";
import { log } from "@/lib/logger";

export interface EbayAdapterConfig {
  app_id: string;
  cert_id: string;
  env?: "production" | "sandbox";
  marketplace?: string;
}

export interface ShopGoodwillAdapterConfig {
  username: string;
  password: string;
}

export interface PriceChartingAdapterConfig {
  api_key: string;
}

export interface AdapterConfig {
  ebay?: Partial<EbayAdapterConfig>;
  shopgoodwill?: Partial<ShopGoodwillAdapterConfig>;
  pricecharting?: Partial<PriceChartingAdapterConfig>;
  /** Discogs needs no credentials — always enabled */
  discogs?: { enabled?: boolean };
  /** HiBid needs no credentials — uses Playwright for Cloudflare bypass */
  hibid?: { enabled?: boolean };
  /** TCGPlayer marketplace search — no credentials needed */
  tcgplayer_market?: { enabled?: boolean };
  /** Mercari — no credentials needed, uses Playwright for API interception */
  mercari?: { enabled?: boolean };
  /** LiveAuctioneers — no credentials needed, public search API */
  liveauctioneers?: { enabled?: boolean };
  /** Whatnot — no credentials needed, uses Playwright for GraphQL interception */
  whatnot?: { enabled?: boolean };
  /** K&L Wines — requires a pre-authenticated Chrome session on :9222 (see scripts/klwines_login.ts) */
  klwines?: { enabled?: boolean; userDataDir?: string; cdpPort?: number };
  /** Bitters & Bottles — Shopify-backed craft spirits store; public products.json, no auth */
  bittersandbottles?: { enabled?: boolean };
}

/**
 * Build all configured marketplace adapters.
 *
 * Adapters are only created when their required credentials are present.
 * Returns a flat array of ready-to-use adapters.
 */
export function buildAdapters(cfg: AdapterConfig): IMarketplaceAdapter[] {
  const adapters: IMarketplaceAdapter[] = [];

  const ebayCfg = cfg.ebay ?? {};
  if (ebayCfg.app_id && ebayCfg.cert_id) {
    adapters.push(
      new EbayAdapter({
        app_id: ebayCfg.app_id,
        cert_id: ebayCfg.cert_id,
        env: ebayCfg.env ?? "production",
        marketplace: ebayCfg.marketplace,
      }),
    );
    log("registry", `built EbayAdapter env=${ebayCfg.env ?? "production"} marketplace=${ebayCfg.marketplace ?? "EBAY_US"}`);
  } else {
    log("registry", "EbayAdapter skipped (missing app_id or cert_id)");
  }

  const sgwCfg = cfg.shopgoodwill ?? {};
  if (sgwCfg.username && sgwCfg.password) {
    adapters.push(
      new ShopGoodwillAdapter({
        username: sgwCfg.username,
        password: sgwCfg.password,
      }),
    );
    log("registry", `built ShopGoodwillAdapter user=${sgwCfg.username}`);
  } else {
    log("registry", "ShopGoodwillAdapter skipped (missing username or password)");
  }

  const pcKey = cfg.pricecharting?.api_key ?? "";
  if (pcKey) {
    adapters.push(new PriceChartingAdapter({ api_key: pcKey }));
    log("registry", "built PriceChartingAdapter");
  } else {
    log("registry", "PriceChartingAdapter skipped (missing api_key)");
  }

  // Discogs requires no credentials — enabled by default unless explicitly disabled.
  const discogsCfg = cfg.discogs ?? {};
  if (discogsCfg.enabled !== false) {
    adapters.push(new DiscogsAdapter());
    log("registry", "built DiscogsAdapter (no-auth; search() returns empty, provides discovery queries)");
  } else {
    log("registry", "DiscogsAdapter skipped (disabled in config)");
  }

  // HiBid — no credentials needed, uses Playwright for Cloudflare bypass
  const hibidCfg = cfg.hibid ?? {};
  if (hibidCfg.enabled !== false) {
    adapters.push(new HiBidAdapter());
    log("registry", "built HiBidAdapter (Playwright + GraphQL)");
  } else {
    log("registry", "HiBidAdapter skipped (disabled in config)");
  }

  // TCGPlayer marketplace search — no credentials needed
  const tcgMarketCfg = cfg.tcgplayer_market ?? {};
  if (tcgMarketCfg.enabled !== false) {
    adapters.push(new TcgPlayerMarketAdapter());
    log("registry", "built TcgPlayerMarketAdapter (no-auth; public search API)");
  } else {
    log("registry", "TcgPlayerMarketAdapter skipped (disabled in config)");
  }

  // Mercari — no credentials needed, uses Playwright for API interception
  const mercariCfg = cfg.mercari ?? {};
  if (mercariCfg.enabled !== false) {
    adapters.push(new MercariAdapter());
    log("registry", "built MercariAdapter (Playwright + API interception)");
  } else {
    log("registry", "MercariAdapter skipped (disabled in config)");
  }

  // LiveAuctioneers — no credentials needed, public search API
  const laCfg = cfg.liveauctioneers ?? {};
  if (laCfg.enabled !== false) {
    adapters.push(new LiveAuctioneersAdapter());
    log("registry", "built LiveAuctioneersAdapter (no-auth; public search API)");
  } else {
    log("registry", "LiveAuctioneersAdapter skipped (disabled in config)");
  }

  // Whatnot — no credentials needed, uses Playwright for GraphQL interception
  const whatnotCfg = cfg.whatnot ?? {};
  if (whatnotCfg.enabled !== false) {
    adapters.push(new WhatnotAdapter());
    log("registry", "built WhatnotAdapter (Playwright + GraphQL)");
  } else {
    log("registry", "WhatnotAdapter skipped (disabled in config)");
  }

  // K&L Wines — enabled by default; KlwinesAdapter.isAvailable() returns false
  // when the session dir doesn't exist (i.e. user hasn't run the login script),
  // and search() degrades to [] if Chrome isn't on the CDP port.
  const klCfg = cfg.klwines ?? {};
  if (klCfg.enabled !== false) {
    const kl = new KlwinesAdapter({
      userDataDir: klCfg.userDataDir,
      cdpPort: klCfg.cdpPort,
    });
    if (kl.isAvailable()) {
      adapters.push(kl);
      log("registry", `built KlwinesAdapter userDataDir=${klCfg.userDataDir ?? "(default)"} cdp=:${klCfg.cdpPort ?? 9222}`);
    } else {
      log("registry", "KlwinesAdapter skipped (no session dir — run scripts/klwines_login.ts first)");
    }
  } else {
    log("registry", "KlwinesAdapter skipped (disabled in config)");
  }

  // Bitters & Bottles — no credentials needed, public Shopify products.json
  const bbCfg = cfg.bittersandbottles ?? {};
  if (bbCfg.enabled !== false) {
    adapters.push(new BittersAndBottlesAdapter());
    log("registry", "built BittersAndBottlesAdapter (no-auth; Shopify public API)");
  } else {
    log("registry", "BittersAndBottlesAdapter skipped (disabled in config)");
  }

  log("registry", `buildAdapters complete: ${adapters.length} adapter(s) active [${adapters.map((a) => a.marketplace_id).join(", ")}]`);
  return adapters;
}
