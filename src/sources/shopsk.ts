import { ShopifyAdapter } from "./shopify_base";

/** shopsk.com — CA-based premium wine, spirits, craft beer. Same-day CA delivery. */
export class ShopSkAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "shopsk",
      baseUrl: "https://shopsk.com",
      fallbackCollections: ["all", "spirits", "wine", "beer"],
      skuKey: "shopsk_sku",
      extraFields: (p) => ({ shopsk_product_id: p.id }),
    });
  }
}
