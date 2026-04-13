import { ShopifyAdapter } from "./shopify_base";

/** wildwoodguitars.com — high-end guitar dealer (Fender Custom Shop, Gibson, Martin). */
export class WildwoodGuitarsAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "wildwoodguitars",
      baseUrl: "https://www.wildwoodguitars.com",
      fallbackCollections: ["all-guitars", "electric", "acoustic", "new-arrivals", "used"],
      skuKey: "wildwood_sku",
    });
  }
}
