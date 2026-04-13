import { ShopifyAdapter } from "./shopify_base";

/** gouletpens.com — fountain pen + ink specialist. */
export class GouletPensAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "gouletpens",
      baseUrl: "https://www.gouletpens.com",
      fallbackCollections: ["fountain-pens", "bottled-ink", "ink-samples", "rollerball-pens", "nibs"],
      skuKey: "goulet_sku",
    });
  }
}
