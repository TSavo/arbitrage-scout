import { ShopifyAdapter } from "./shopify_base";

/** sipwhiskey.com — online whiskey + spirits retailer (Bourbon, Tequila, Rye, Scotch). */
export class SipWhiskeyAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "sipwhiskey",
      baseUrl: "https://sipwhiskey.com",
      fallbackCollections: ["all-bourbon", "american-whiskey", "scotch", "tequila", "rye-whiskey"],
      skuKey: "sipwhiskey_sku",
    });
  }
}
