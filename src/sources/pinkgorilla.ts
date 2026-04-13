import { ShopifyAdapter } from "./shopify_base";

/** pinkgorillagames.com — retro games + plushies (Pokemon / Sanrio / Mario / Kirby). */
export class PinkGorillaAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "pinkgorilla",
      baseUrl: "https://pinkgorillagames.com",
      fallbackCollections: ["all-products", "plushies", "video-games", "books"],
      skuKey: "pinkgorilla_sku",
    });
  }
}
