import type { RawListing, ValidatedListing } from '../types';
import { generateId } from '../utils';

export interface ValidationInput {
  readonly listing: RawListing;
}

export interface ValidationOutput {
  readonly listing: ValidatedListing;
  readonly errors: readonly string[];
  readonly isValid: boolean;
}

export type ValidationCommand = {
  readonly id: string;
  readonly type: 'validate';
  readonly input: ValidationInput;
  readonly output: ValidationOutput;
  readonly timestamp: number;
  readonly durationMs: number;
};

export function validate(input: ValidationInput): ValidationOutput {
  const errors: string[] = [];

  if (!input.listing.listingId?.trim()) {
    errors.push('missing listingId');
  }

  if (!input.listing.marketplaceId?.trim()) {
    errors.push('missing marketplaceId');
  }

  if (!input.listing.priceUsd || input.listing.priceUsd <= 0) {
    errors.push('invalid or missing price');
  }

  if (!input.listing.url?.trim()) {
    errors.push('missing url');
  }

  if (!input.listing.title?.trim()) {
    errors.push('missing title');
  }

  if (input.listing.shippingUsd < 0) {
    errors.push('negative shipping not allowed');
  }

  const validatedAt = Date.now();

  const validated: ValidatedListing = Object.freeze({
    ...input.listing,
    validated: true,
    validationErrors: Object.freeze([...errors]),
    validatedAt,
  });

  return {
    listing: validated,
    errors: Object.freeze([...errors]),
    isValid: errors.length === 0,
  };
}

export function createValidationCommand(listing: RawListing): ValidationCommand {
  const start = Date.now();
  const output = validate({ listing });
  const durationMs = Date.now() - start;

  return Object.freeze({
    id: generateId('val'),
    type: 'validate',
    input: { listing },
    output,
    timestamp: start,
    durationMs,
  });
}
