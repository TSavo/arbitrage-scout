import type { Opportunity, ExtractedItem, CatalogMatch } from '../types';
import { db } from '@/db/client';
import { opportunities, listingItems, listings } from '@/db/schema';
import { eq, and } from 'drizzle-orm';
import { embeddingRepo } from '@/db/repos/EmbeddingRepo';

export interface StoreInput {
  readonly listingId: string;
  readonly marketplaceId: string;
  readonly marketplaceListingId: string;
  readonly title: string;
  readonly url: string;
  readonly priceUsd: number;
  readonly shippingUsd: number;
  readonly seller?: string;
  readonly items: readonly ExtractedItem[];
  readonly matches: ReadonlyMap<number, CatalogMatch | null>;
  readonly topCandidates: ReadonlyMap<number, CatalogMatch | null>;
  readonly opportunities: readonly Opportunity[];
  readonly validatedAt: number;
  readonly ollamaUrl?: string;
}

export interface StoreOutput {
  readonly listingDbId: number;
  readonly itemsStored: number;
  readonly opportunitiesStored: number;
  readonly embedded: {
    readonly products: number;
    readonly listings: number;
  };
  readonly storedAt: number;
}

export type StoreCommand = {
  readonly id: string;
  readonly type: 'store';
  readonly input: StoreInput;
  readonly output: StoreOutput;
  readonly timestamp: number;
  readonly durationMs: number;
};

export async function store(input: StoreInput): Promise<StoreOutput> {
  const start = Date.now();
  const now = new Date().toISOString();
  const ollamaUrl = input.ollamaUrl ?? process.env.OLLAMA_URL ?? 'http://battleaxe:11434';

  const existingListing = db
    .select({ id: listings.id })
    .from(listings)
    .where(
      and(
        eq(listings.marketplaceId, input.marketplaceId),
        eq(listings.marketplaceListingId, input.marketplaceListingId)
      )
    )
    .limit(1)
    .all()[0];

  let listingDbId: number;
  let isNewListing = false;

  if (existingListing) {
    db.update(listings)
      .set({
        title: input.title,
        url: input.url ?? undefined,
        priceUsd: input.priceUsd,
        shippingUsd: input.shippingUsd,
        seller: input.seller ?? undefined,
        lastSeenAt: now,
        isActive: true,
      })
      .where(eq(listings.id, existingListing.id))
      .run();
    listingDbId = existingListing.id;
  } else {
    const inserted = db.insert(listings)
      .values({
        marketplaceId: input.marketplaceId,
        marketplaceListingId: input.marketplaceListingId,
        url: input.url ?? null,
        title: input.title,
        priceUsd: input.priceUsd,
        shippingUsd: input.shippingUsd,
        seller: input.seller ?? null,
        isLot: input.items.length > 1,
        firstSeenAt: now,
        lastSeenAt: now,
        isActive: true,
      })
      .returning({ id: listings.id })
      .get();
    listingDbId = inserted.id;
    isNewListing = true;
  }

  let itemsStored = 0;
  let opportunitiesStored = 0;
  let productsEmbedded = 0;
  let listingsEmbedded = 0;

  for (let idx = 0; idx < input.items.length; idx++) {
    const item = input.items[idx];
    const match = input.matches.get(idx);
    const topCandidate = input.topCandidates.get(idx);

    if (match) {
      const confirmed = match.score >= 0.7;

      db.insert(listingItems)
        .values({
          listingId: listingDbId,
          productId: match.productId,
          quantity: item.quantity,
          condition: item.condition ?? 'loose',
          conditionDetails: item.metadata as unknown as Record<string, unknown>,
          estimatedValueUsd: 0,
          confidence: match.score,
          confirmed,
          rawExtraction: {
            name: item.name,
            productType: item.productType,
            platform: item.platform,
            condition: item.condition,
            metadata: item.metadata,
          },
        })
        .onConflictDoNothing()
        .run();

      itemsStored++;

      if (confirmed) {
        await embedProduct(match.productId, `${match.title} ${match.platform ?? ''}`, ollamaUrl);
        productsEmbedded++;
      }
    } else if (topCandidate) {
      db.insert(listingItems)
        .values({
          listingId: listingDbId,
          productId: topCandidate.productId,
          quantity: item.quantity,
          condition: item.condition ?? 'loose',
          conditionDetails: item.metadata as unknown as Record<string, unknown>,
          estimatedValueUsd: 0,
          confidence: topCandidate.score,
          confirmed: false,
          rawExtraction: {
            name: item.name,
            productType: item.productType,
            platform: item.platform,
            condition: item.condition,
            metadata: { ...item.metadata, rejected: true },
          },
        })
        .onConflictDoNothing()
        .run();

      itemsStored++;
    }
  }

  for (const opp of input.opportunities) {
    const existing = db
      .select({ id: opportunities.id })
      .from(opportunities)
      .where(and(
        eq(opportunities.listingId, listingDbId),
        eq(opportunities.productId, opp.productId)
      ))
      .limit(1)
      .all()[0];

    if (existing) {
      db.update(opportunities)
        .set({
          listingPriceUsd: opp.cost,
          marketPriceUsd: opp.marketPrice,
          profitUsd: Math.round(opp.profit * 100) / 100,
          marginPct: Math.round(opp.margin * 10000) / 10000,
          potentialProfitUsd: opp.potentialProfit ? Math.round(opp.potentialProfit * 100) / 100 : undefined,
          potentialMarginPct: opp.potentialMargin ? Math.round(opp.potentialMargin * 10000) / 10000 : undefined,
          status: 'updated',
        })
        .where(eq(opportunities.id, existing.id))
        .run();
    } else {
      db.insert(opportunities)
        .values({
          listingId: listingDbId,
          productId: opp.productId,
          listingPriceUsd: opp.cost,
          marketPriceUsd: opp.marketPrice,
          marketPriceSource: 'pricecharting',
          marketPriceCondition: opp.condition,
          profitUsd: Math.round(opp.profit * 100) / 100,
          marginPct: Math.round(opp.margin * 10000) / 10000,
          potentialProfitUsd: opp.potentialProfit ? Math.round(opp.potentialProfit * 100) / 100 : undefined,
          potentialMarginPct: opp.potentialMargin ? Math.round(opp.potentialMargin * 10000) / 10000 : undefined,
          confidence: opp.confidence,
          flags: serializeFlags(opp.flags),
          status: 'new',
          foundAt: now,
        })
        .run();
      opportunitiesStored++;
    }
  }

  if (isNewListing) {
    const listingText = `${input.title} ${input.marketplaceId}`.trim();
    await embedListing(listingDbId.toString(), listingText, ollamaUrl);
    listingsEmbedded++;
  }

  return Object.freeze({
    listingDbId,
    itemsStored,
    opportunitiesStored,
    embedded: Object.freeze({
      products: productsEmbedded,
      listings: listingsEmbedded,
    }),
    storedAt: start,
  });
}

async function embedProduct(productId: string, text: string, ollamaUrl: string): Promise<void> {
  try {
    await embeddingRepo.getOrCompute('product', productId, text, ollamaUrl);
  } catch {
    // Non-critical - embedding will be generated in next batch job
  }
}

async function embedListing(listingId: string, text: string, ollamaUrl: string): Promise<void> {
  try {
    await embeddingRepo.getOrCompute('listing', listingId, text, ollamaUrl);
  } catch {
    // Non-critical - embedding will be generated in next batch job
  }
}

function serializeFlags(flags: Opportunity['flags']): string[] {
  const result: string[] = [];
  if (flags.auctionMayIncrease) result.push('auction_may_increase');
  if (flags.verifyAuthenticity) result.push('verify_authenticity');
  if (flags.isLot) result.push('is_lot');
  return result;
}
