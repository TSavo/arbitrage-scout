import { ShopifyAdapter } from "./shopify_base";

/** flaviar.com — curated spirits club retailer. */
export class FlaviarAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "flaviar",
      baseUrl: "https://flaviar.com",
      fallbackCollections: ["all", "whiskey", "bourbon", "tequila"],
      skuKey: "flaviar_sku",
      extraFields: (p) => ({ flaviar_product_id: p.id }),
    });
  }
}
