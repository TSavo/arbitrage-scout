import { ShopifyAdapter } from "./shopify_base";

/** retrogameboyz.com — retro gaming specialist, Atari 2600/7800/Commodore 64 focus. */
export class RetroGameBoyzAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "retrogameboyz",
      baseUrl: "https://retrogameboyz.com",
      fallbackCollections: ["all", "atari-2600", "atari-7800", "commodore-64", "colecovision"],
      skuKey: "retrogameboyz_sku",
    });
  }
}
