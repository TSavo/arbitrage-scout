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

  log("registry", `buildAdapters complete: ${adapters.length} adapter(s) active [${adapters.map((a) => a.marketplace_id).join(", ")}]`);
  return adapters;
}
