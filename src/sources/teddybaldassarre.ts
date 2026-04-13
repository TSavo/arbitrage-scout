import { ShopifyAdapter } from "./shopify_base";

/** teddybaldassarre.com — watch retailer (Tudor, Omega, Seiko, Longines). */
export class TeddyBaldassarreAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "teddybaldassarre",
      baseUrl: "https://teddybaldassarre.com",
      fallbackCollections: ["all-watches", "new-releases", "stocked", "pre-owned"],
      skuKey: "teddybaldassarre_sku",
    });
  }
}
