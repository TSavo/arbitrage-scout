import { ShopifyAdapter } from "./shopify_base";

/** trollandtoad.com — trading card + TCG retailer (Pokemon, MTG, Yu-Gi-Oh singles + sealed). */
export class TrollAndToadAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "trollandtoad",
      baseUrl: "https://www.trollandtoad.com",
      fallbackCollections: ["all", "pokemon", "magic-the-gathering", "yu-gi-oh", "one-piece"],
      skuKey: "trollandtoad_sku",
    });
  }
}
