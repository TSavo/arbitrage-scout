export interface RawListing {
  readonly marketplaceId: string;
  readonly listingId: string;
  readonly title: string;
  readonly priceUsd: number;
  readonly shippingUsd: number;
  readonly url: string;
  readonly description?: string;
  readonly conditionRaw?: string;
  readonly categoryRaw?: string;
  readonly imageUrl?: string;
  readonly seller?: string;
  readonly numBids?: number;
  readonly itemCount?: number;
  readonly endTime?: string;
  readonly extra?: Record<string, unknown>;
  readonly scrapedAt: number;
}

export type MetadataValue = string | number | boolean;

export interface ExtractedItem {
  readonly id: string;
  readonly name: string;
  readonly productType: string;
  readonly condition?: string;
  readonly platform?: string;
  readonly quantity: number;
  readonly confidence: number;
  readonly metadata: Readonly<Record<string, MetadataValue>>;
}

export interface CatalogMatch {
  readonly productId: string;
  readonly title: string;
  readonly score: number;
  readonly method: 'fts5' | 'embedding' | 'difflib';
  readonly productTypeId: string;
  readonly platform?: string;
  readonly condition?: string;
}

export interface ValidatedListing extends RawListing {
  readonly validated: true;
  readonly validationErrors: readonly string[];
  readonly validatedAt: number;
}

export interface OpportunityFlags {
  readonly auctionMayIncrease: boolean;
  readonly verifyAuthenticity: boolean;
  readonly isLot: boolean;
}

export interface Opportunity {
  readonly id: string;
  readonly listingId: string;
  readonly productId: string;
  readonly productTitle: string;
  /** Legacy single-axis label. Use priceDimensions for multi-axis pricing. */
  readonly condition: string;
  /** JSON map of pricing-axis values used to look up marketPrice. */
  readonly priceDimensions: Readonly<Record<string, MetadataValue>>;
  readonly marketPrice: number;
  readonly cost: number;
  readonly profit: number;
  readonly margin: number;
  readonly potentialProfit?: number;
  readonly potentialMargin?: number;
  readonly flags: OpportunityFlags;
  readonly confidence: number;
  readonly createdAt: number;
}

export interface PipelineEvent {
  readonly type: 'listing.processed' | 'opportunity.found' | 'handler.start' | 'handler.complete' | 'handler.error' | 'command.issued';
  readonly handler: string;
  readonly timestamp: number;
  readonly data: Record<string, unknown>;
}

export interface CommandIssuedEventData {
  readonly handler: string;
  readonly commandType: string;
  readonly commandId: string;
  readonly durationMs: number;
  readonly input: unknown;
  readonly output: unknown;
}

export interface OpportunityFoundEventData {
  readonly handler: string;
  readonly listingId: string;
  readonly opportunity: Opportunity;
}

export interface HandlerErrorEventData {
  readonly handler: string;
  readonly error: string;
  readonly commandType?: string;
}

export interface PipelineConfig {
  readonly extractionBatchSize: number;
  readonly matchingStrategies: string[];
  readonly minProfitUsd: number;
  readonly minMarginPct: number;
  readonly maxRetries: number;
  readonly llmUrl: string;
  readonly llmModel: string;
}

export interface Command<TInput = unknown, TOutput = unknown> {
  readonly id: string;
  readonly type: string;
  readonly handler: string;
  readonly input: TInput;
  readonly output: TOutput;
  readonly error?: string;
  readonly timestamp: number;
  readonly durationMs: number;
}

export interface DeduplicationResult {
  readonly conflictsFound: number;
  readonly resolvedCount: number;
  readonly details: ReadonlyArray<{
    itemIndex: number;
    note: string;
  }>;
}
