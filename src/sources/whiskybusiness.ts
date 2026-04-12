import { ShopifyAdapter } from "./shopify_base";

/** whiskybusiness.com — whiskey specialist. Ships to CA. */
export class WhiskyBusinessAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "whiskybusiness",
      baseUrl: "https://whiskybusiness.com",
      fallbackCollections: ["all", "bourbon", "whiskey", "scotch"],
      skuKey: "whiskybusiness_sku",
      extraFields: (p) => ({ whiskybusiness_product_id: p.id }),
    });
  }
}
