import { ShopifyAdapter } from "./shopify_base";

/** woodencork.com — craft whiskey + rare allocations retailer. Ships to CA. */
export class WoodenCorkAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "woodencork",
      baseUrl: "https://woodencork.com",
      fallbackCollections: ["all", "bourbon", "whiskey", "scotch"],
      skuKey: "woodencork_sku",
      extraFields: (p) => ({ woodencork_product_id: p.id }),
    });
  }
}
