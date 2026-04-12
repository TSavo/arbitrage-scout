import { randomBytes } from 'crypto';
import type { RawListing as AdapterRawListing } from '@/sources/IMarketplaceAdapter';
import type { RawListing } from './types';

export function toRawListing(raw: AdapterRawListing): RawListing {
  return {
    marketplaceId: raw.marketplace_id,
    listingId: raw.listing_id,
    title: raw.title,
    priceUsd: raw.price_usd,
    shippingUsd: raw.shipping_usd ?? 0,
    url: raw.url ?? '',
    description: raw.description,
    conditionRaw: raw.condition_raw,
    categoryRaw: raw.category_raw,
    imageUrl: raw.image_url,
    seller: raw.seller,
    numBids: raw.num_bids,
    itemCount: raw.item_count,
    endTime: raw.end_time,
    extra: raw.extra,
    scrapedAt: Date.now(),
  };
}

export function generateId(prefix = ''): string {
  const bytes = randomBytes(8);
  const hex = bytes.toString('hex');
  return prefix ? `${prefix}_${hex}` : hex;
}

export function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
