import { ShopifyAdapter } from "./shopify_base";

/** lastbottlewines.com — daily-offer wine flash deals. */
export class LastBottleWinesAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "lastbottlewines",
      baseUrl: "https://www.lastbottlewines.com",
      fallbackCollections: ["all", "red", "white", "sparkling"],
      skuKey: "lastbottle_sku",
    });
  }
}
