import { ShopifyAdapter } from "./shopify_base";

/** bittersandbottles.com — craft spirits, SF Bay Area. Ships CA + nationwide. */
export class BittersAndBottlesAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "bittersandbottles",
      baseUrl: "https://www.bittersandbottles.com",
      fallbackCollections: ["spirits", "bitters", "liqueur", "mixers", "new-arrivals"],
      skuKey: "bb_sku",
      extraFields: (p) => ({ bb_product_id: p.id }),
    });
  }
}
