import { ShopifyAdapter } from "./shopify_base";

/** minifigs.me — LEGO minifigure specialist (custom + authentic bits, UK). */
export class MinifigsAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "minifigs_me",
      baseUrl: "https://www.minifigs.me",
      fallbackCollections: ["all", "minifigs", "lego-bits"],
      skuKey: "minifigs_sku",
    });
  }
}
