import { ShopifyAdapter } from "./shopify_base";

/** chicagomusicexchange.com — guitars, amps, pedals, basses (Gibson, Fender, PRS, JHS, Novo). */
export class ChicagoMusicExchangeAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "chicagomusicexchange",
      baseUrl: "https://www.chicagomusicexchange.com",
      fallbackCollections: ["electric-guitars", "acoustic-guitars", "bass-guitars", "amps", "effects-pedals"],
      skuKey: "cme_sku",
    });
  }
}
