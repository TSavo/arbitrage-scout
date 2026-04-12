import { ShopifyAdapter } from "./shopify_base";

/** seelbachs.com — allocated bourbons, indie releases, NDP picks. Ships to CA. */
export class SeelbachsAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "seelbachs",
      baseUrl: "https://seelbachs.com",
      fallbackCollections: ["bourbon", "all", "distillers", "non-distiller-producer"],
      skuKey: "seelbachs_sku",
      extraFields: (p) => ({ seelbachs_product_id: p.id }),
    });
  }
}
