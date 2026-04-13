import { ShopifyAdapter } from "./shopify_base";

/** plug.tech — refurbished consumer electronics (Apple / Samsung / Google phones, iPads, laptops). */
export class PlugTechAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "plugtech",
      baseUrl: "https://plug.tech",
      fallbackCollections: ["all", "iphone", "ipad", "macbook", "samsung-galaxy", "apple-watch"],
      skuKey: "plugtech_sku",
    });
  }
}
