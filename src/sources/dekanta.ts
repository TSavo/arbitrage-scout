import { ShopifyAdapter } from "./shopify_base";

/** dekanta.com — Japanese whisky specialist. Deep catalog of Suntory, Nikka, Chichibu, Nagahama. */
export class DekantaAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "dekanta",
      baseUrl: "https://dekanta.com",
      fallbackCollections: ["all", "whisky", "japanese-whisky", "sale"],
      skuKey: "dekanta_sku",
    });
  }
}
