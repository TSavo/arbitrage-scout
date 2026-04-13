import { ShopifyAdapter } from "./shopify_base";

/** upscaleaudio.com — high-end HiFi (turntables, cartridges, tube amps, floorstanders). */
export class UpscaleAudioAdapter extends ShopifyAdapter {
  constructor() {
    super({
      marketplaceId: "upscaleaudio",
      baseUrl: "https://upscaleaudio.com",
      fallbackCollections: ["turntables", "cartridges", "loudspeakers", "amplifiers", "phonostages", "preamplifiers"],
      skuKey: "upscaleaudio_sku",
    });
  }
}
