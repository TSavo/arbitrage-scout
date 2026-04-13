import { ShopifyAdapter } from "./shopify_base";

/** windupwatchshop.com — enthusiast / indie watch retailer (Benrus, Laco, G-Shock). */
export class WindupWatchShopAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "windupwatchshop",
      baseUrl: "https://windupwatchshop.com",
      fallbackCollections: ["all", "watches", "new-arrivals", "sale"],
      skuKey: "windup_sku",
    });
  }
}
