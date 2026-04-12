import { ShopifyAdapter } from "./shopify_base";

/** caskcartel.com — allocated/rare bourbon, tequila, scotch. Ships to CA. */
export class CaskCartelAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "caskcartel",
      baseUrl: "https://www.caskcartel.com",
      fallbackCollections: ["all", "bourbon", "whiskey", "tequila"],
      skuKey: "caskcartel_sku",
      extraFields: (p) => ({ caskcartel_product_id: p.id }),
    });
  }
}
