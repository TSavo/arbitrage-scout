import { ShopifyAdapter } from "./shopify_base";

/** watchgecko.com — watch straps + enthusiast watches (Nivada Grenchen, Boldr). */
export class WatchGeckoAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "watchgecko",
      baseUrl: "https://www.watchgecko.com",
      fallbackCollections: ["watches", "watch-straps", "accessories"],
      skuKey: "watchgecko_sku",
    });
  }
}
