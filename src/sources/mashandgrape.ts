import { ShopifyAdapter } from "./shopify_base";

/** mashandgrape.com — curated craft spirits retailer. */
export class MashAndGrapeAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "mashandgrape",
      baseUrl: "https://www.mashandgrape.com",
      fallbackCollections: ["all-spirits", "bourbon", "whiskey", "gin", "rum", "tequila", "vodka"],
      skuKey: "mashandgrape_sku",
    });
  }
}
