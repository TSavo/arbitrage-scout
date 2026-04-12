import type { CatalogMatch, Opportunity, OpportunityFlags, ValidatedListing, MetadataValue } from '../types';
import { generateId } from '../utils';
import { getMarketPrice, type PriceData, type PriceDimensions } from './price';

export type { PriceData } from './price';

export interface EvaluateInput {
  readonly listing: ValidatedListing;
  readonly matches: ReadonlyMap<number, CatalogMatch | null>;
  readonly prices: ReadonlyMap<string, PriceData>;
  readonly confirmedIndices: ReadonlySet<number>;
  readonly thresholds: OpportunityThresholds;
  /** Optional per-item pricing dimensions (derived from item metadata + schema). */
  readonly dimensions?: ReadonlyMap<number, PriceDimensions>;
}

export interface EvaluateOutput {
  readonly opportunities: readonly Opportunity[];
  readonly evaluatedCount: number;
  readonly opportunityCount: number;
  readonly evaluatedAt: number;
}

export interface OpportunityThresholds {
  readonly minProfitUsd: number;
  readonly minMarginPct: number;
  readonly feeRate: number;
  readonly shippingOutUsd: number;
}

export type EvaluateCommand = {
  readonly id: string;
  readonly type: 'evaluate';
  readonly input: EvaluateInput;
  readonly output: EvaluateOutput;
  readonly timestamp: number;
  readonly durationMs: number;
};

const DEFAULT_THRESHOLDS: OpportunityThresholds = {
  minProfitUsd: 25,
  minMarginPct: 0.30,
  feeRate: 0.15,
  shippingOutUsd: 5,
};

export function evaluate(input: EvaluateInput): EvaluateOutput {
  const start = Date.now();
  const thresholds = { ...DEFAULT_THRESHOLDS, ...input.thresholds };
  const opportunities: Opportunity[] = [];

  const confirmedCount = input.confirmedIndices.size > 0 
    ? input.confirmedIndices.size 
    : [...input.matches.values()].filter(Boolean).length;

  const totalItems = input.matches.size;
  if (totalItems === 0) {
    return Object.freeze({
      opportunities: [],
      evaluatedCount: 0,
      opportunityCount: 0,
      evaluatedAt: start,
    });
  }

  const totalCost = input.listing.priceUsd + input.listing.shippingUsd;
  const costPerConfirmed = confirmedCount > 0 ? totalCost / confirmedCount : totalCost;
  const costPerItem = totalCost / totalItems;

  let evaluatedCount = 0;
  let opportunityCount = 0;

  for (let idx = 0; idx < totalItems; idx++) {
    const match = input.matches.get(idx);
    if (!match) continue;

    const priceData = input.prices.get(match.productId);
    if (!priceData) continue;

    evaluatedCount++;

    const dims = input.dimensions?.get(idx);
    const marketPrice = getMarketPrice(priceData, dims);
    if (marketPrice <= 0) continue;

    const isConfirmed = input.confirmedIndices.has(idx);

    const conservativeCost = costPerConfirmed;
    const potentialCost = costPerItem;

    const conservativeProfit = marketPrice * (1 - thresholds.feeRate) - conservativeCost - thresholds.shippingOutUsd;
    const potentialProfit = marketPrice * (1 - thresholds.feeRate) - potentialCost - thresholds.shippingOutUsd;

    const margin = conservativeCost > 0 ? conservativeProfit / conservativeCost : 0;
    const potentialMargin = potentialCost > 0 ? potentialProfit / potentialCost : 0;

    if (conservativeProfit < thresholds.minProfitUsd || margin < thresholds.minMarginPct) {
      continue;
    }

    const flags = computeFlags(input.listing, margin);

    const priceDimensions: Readonly<Record<string, MetadataValue>> = Object.freeze({ ...(dims ?? {}) });
    const conditionLabel = typeof priceDimensions.condition === 'string'
      ? priceDimensions.condition
      : (match.condition ?? '');

    const opportunity: Opportunity = Object.freeze({
      id: generateId('opp'),
      listingId: '',
      productId: match.productId,
      productTitle: match.title,
      condition: conditionLabel,
      priceDimensions,
      marketPrice,
      cost: conservativeCost,
      profit: conservativeProfit,
      margin,
      potentialProfit,
      potentialMargin,
      flags,
      confidence: match.score,
      createdAt: start,
    });

    opportunities.push(opportunity);
    opportunityCount++;
  }

  return Object.freeze({
    opportunities: Object.freeze([...opportunities]),
    evaluatedCount,
    opportunityCount,
    evaluatedAt: start,
  });
}

function computeFlags(listing: ValidatedListing, margin: number): OpportunityFlags {
  const isLot = listing.itemCount !== undefined && listing.itemCount > 1;
  const hasBids = listing.numBids !== undefined && listing.numBids > 0;
  const highMargin = margin >= 2.0;

  return Object.freeze({
    auctionMayIncrease: hasBids || isLot,
    verifyAuthenticity: highMargin,
    isLot,
  });
}
