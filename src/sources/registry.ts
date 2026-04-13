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
import { SeelbachsAdapter } from "./seelbachs";
import { ShopSkAdapter } from "./shopsk";
import { WoodenCorkAdapter } from "./woodencork";
import { CaskCartelAdapter } from "./caskcartel";
import { WhiskyBusinessAdapter } from "./whiskybusiness";
import { FlaviarAdapter } from "./flaviar";
import { MashAndGrapeAdapter } from "./mashandgrape";
import { DekantaAdapter } from "./dekanta";
import { LastBottleWinesAdapter } from "./lastbottlewines";
import { TrollAndToadAdapter } from "./trollandtoad";
import { MinifigsAdapter } from "./minifigs";
import { TeddyBaldassarreAdapter } from "./teddybaldassarre";
import { WindupWatchShopAdapter } from "./windupwatchshop";
import { PlugTechAdapter } from "./plugtech";
import { GouletPensAdapter } from "./gouletpens";
import { SipWhiskeyAdapter } from "./sipwhiskey";
import { WatchGeckoAdapter } from "./watchgecko";
import { AtlanticKnifeAdapter } from "./atlanticknife";
import { UpscaleAudioAdapter } from "./upscaleaudio";
import { PinkGorillaAdapter } from "./pinkgorilla";
import { RetroGameBoyzAdapter } from "./retrogameboyz";
import { SneakerPoliticsAdapter } from "./sneakerpolitics";
import { WildwoodGuitarsAdapter } from "./wildwoodguitars";
import { ChicagoMusicExchangeAdapter } from "./chicagomusicexchange";
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
  /** Seelbach's — allocated bourbons (Shopify) */
  seelbachs?: { enabled?: boolean };
  /** ShopSK — CA-based premium wine+spirits+beer (Shopify) */
  shopsk?: { enabled?: boolean };
  /** Wooden Cork — craft whiskey (Shopify) */
  woodencork?: { enabled?: boolean };
  /** Cask Cartel — allocated/rare bourbon+tequila (Shopify) */
  caskcartel?: { enabled?: boolean };
  /** Whisky Business — whiskey specialist (Shopify) */
  whiskybusiness?: { enabled?: boolean };
  /** Flaviar — curated spirits retailer (Shopify) */
  flaviar?: { enabled?: boolean };
  // Batch 2 Shopify-backed retailers (no auth)
  mashandgrape?: { enabled?: boolean };
  dekanta?: { enabled?: boolean };
  lastbottlewines?: { enabled?: boolean };
  trollandtoad?: { enabled?: boolean };
  minifigs?: { enabled?: boolean };
  teddybaldassarre?: { enabled?: boolean };
  windupwatchshop?: { enabled?: boolean };
  plugtech?: { enabled?: boolean };
  gouletpens?: { enabled?: boolean };
  sipwhiskey?: { enabled?: boolean };
  watchgecko?: { enabled?: boolean };
  atlanticknife?: { enabled?: boolean };
  upscaleaudio?: { enabled?: boolean };
  pinkgorilla?: { enabled?: boolean };
  retrogameboyz?: { enabled?: boolean };
  sneakerpolitics?: { enabled?: boolean };
  wildwoodguitars?: { enabled?: boolean };
  chicagomusicexchange?: { enabled?: boolean };
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

  // CDP-dependent adapters — they connect to a headed Chrome on
  // 127.0.0.1:9222. Disable in headless container deployments by setting
  // CDP_ADAPTERS_ENABLED=false.
  const cdpDisabled = process.env.CDP_ADAPTERS_ENABLED === "false";

  // HiBid — no credentials needed, uses Playwright for Cloudflare bypass
  const hibidCfg = cfg.hibid ?? {};
  if (hibidCfg.enabled !== false && !cdpDisabled) {
    adapters.push(new HiBidAdapter());
    log("registry", "built HiBidAdapter (Playwright + GraphQL)");
  } else {
    log("registry", `HiBidAdapter skipped (${cdpDisabled ? "no CDP available" : "disabled in config"})`);
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
  if (mercariCfg.enabled !== false && !cdpDisabled) {
    adapters.push(new MercariAdapter());
    log("registry", "built MercariAdapter (Playwright + API interception)");
  } else {
    log("registry", `MercariAdapter skipped (${cdpDisabled ? "no CDP available" : "disabled in config"})`);
  }

  // LiveAuctioneers — no credentials needed, public search API
  const laCfg = cfg.liveauctioneers ?? {};
  if (laCfg.enabled !== false && !cdpDisabled) {
    adapters.push(new LiveAuctioneersAdapter());
    log("registry", "built LiveAuctioneersAdapter (no-auth; public search API)");
  } else {
    log("registry", `LiveAuctioneersAdapter skipped (${cdpDisabled ? "no CDP available" : "disabled in config"})`);
  }

  // Whatnot — no credentials needed, uses Playwright for GraphQL interception
  const whatnotCfg = cfg.whatnot ?? {};
  if (whatnotCfg.enabled !== false && !cdpDisabled) {
    adapters.push(new WhatnotAdapter());
    log("registry", "built WhatnotAdapter (Playwright + GraphQL)");
  } else {
    log("registry", `WhatnotAdapter skipped (${cdpDisabled ? "no CDP available" : "disabled in config"})`);
  }

  // K&L Wines — enabled by default; KlwinesAdapter.isAvailable() returns false
  // when the session dir doesn't exist (i.e. user hasn't run the login script),
  // and search() degrades to [] if Chrome isn't on the CDP port.
  const klCfg = cfg.klwines ?? {};
  // env override — KLWINES_ENABLED=false disables the adapter for
  // headless deployments (Docker on battleaxe) where there's no headed
  // Chrome with logged-in K&L cookies.
  const klEnvDisabled = process.env.KLWINES_ENABLED === "false";
  if (klCfg.enabled !== false && !klEnvDisabled) {
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

  // Shopify-backed spirits retailers — all no-auth, same pattern.
  const shopifyStores: Array<[string, keyof AdapterConfig, () => IMarketplaceAdapter]> = [
    ["BittersAndBottles", "bittersandbottles", () => new BittersAndBottlesAdapter()],
    ["Seelbachs",         "seelbachs",         () => new SeelbachsAdapter()],
    ["ShopSK",            "shopsk",            () => new ShopSkAdapter()],
    ["WoodenCork",        "woodencork",        () => new WoodenCorkAdapter()],
    ["CaskCartel",        "caskcartel",        () => new CaskCartelAdapter()],
    ["WhiskyBusiness",    "whiskybusiness",    () => new WhiskyBusinessAdapter()],
    ["Flaviar",           "flaviar",           () => new FlaviarAdapter()],
    ["MashAndGrape",      "mashandgrape",      () => new MashAndGrapeAdapter()],
    ["Dekanta",           "dekanta",           () => new DekantaAdapter()],
    ["LastBottleWines",   "lastbottlewines",   () => new LastBottleWinesAdapter()],
    ["TrollAndToad",      "trollandtoad",      () => new TrollAndToadAdapter()],
    ["Minifigs",          "minifigs",          () => new MinifigsAdapter()],
    ["TeddyBaldassarre",  "teddybaldassarre",  () => new TeddyBaldassarreAdapter()],
    ["WindupWatchShop",   "windupwatchshop",   () => new WindupWatchShopAdapter()],
    ["PlugTech",          "plugtech",          () => new PlugTechAdapter()],
    ["GouletPens",        "gouletpens",        () => new GouletPensAdapter()],
    ["SipWhiskey",        "sipwhiskey",        () => new SipWhiskeyAdapter()],
    ["WatchGecko",        "watchgecko",        () => new WatchGeckoAdapter()],
    ["AtlanticKnife",     "atlanticknife",     () => new AtlanticKnifeAdapter()],
    ["UpscaleAudio",      "upscaleaudio",      () => new UpscaleAudioAdapter()],
    ["PinkGorilla",       "pinkgorilla",       () => new PinkGorillaAdapter()],
    ["RetroGameBoyz",     "retrogameboyz",     () => new RetroGameBoyzAdapter()],
    ["SneakerPolitics",   "sneakerpolitics",   () => new SneakerPoliticsAdapter()],
    ["WildwoodGuitars",   "wildwoodguitars",   () => new WildwoodGuitarsAdapter()],
    ["ChicagoMusicExchange", "chicagomusicexchange", () => new ChicagoMusicExchangeAdapter()],
  ];
  for (const [name, key, factory] of shopifyStores) {
    const conf = (cfg[key] as { enabled?: boolean } | undefined) ?? {};
    if (conf.enabled !== false) {
      adapters.push(factory());
      log("registry", `built ${name}Adapter (Shopify public API)`);
    } else {
      log("registry", `${name}Adapter skipped (disabled in config)`);
    }
  }

  log("registry", `buildAdapters complete: ${adapters.length} adapter(s) active [${adapters.map((a) => a.marketplace_id).join(", ")}]`);
  return adapters;
}
