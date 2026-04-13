import { ShopifyAdapter } from "./shopify_base";

/** sneakerpolitics.com — streetwear + sneaker boutique (Nike, Billionaire Boys Club, Stussy). */
export class SneakerPoliticsAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "sneakerpolitics",
      baseUrl: "https://sneakerpolitics.com",
      fallbackCollections: ["sneakers", "apparel", "tops", "hats", "new-arrivals"],
      skuKey: "sneakerpolitics_sku",
    });
  }
}
