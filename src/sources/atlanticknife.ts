import { ShopifyAdapter } from "./shopify_base";

/** atlanticknife.com — EDC knives (folding + fixed blade) + flashlights. Chaves, Microtech, etc. */
export class AtlanticKnifeAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "atlanticknife",
      baseUrl: "https://atlanticknife.com",
      fallbackCollections: ["folding-knives", "fixed-blade", "flashlights", "all-products"],
      skuKey: "atlanticknife_sku",
    });
  }
}
