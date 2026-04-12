// Legacy commands (kept for back-compat with code that still imports them).
export { validate, type ValidationInput, type ValidationOutput } from './validate';
export { ruleBasedExtract, llmExtract, getProductTypeSchema, type ProductTypeSchema, type ExtractInput, type ExtractOutput } from './extract';
export { match, type MatchOutput, type MatchCommand, type MatchInput, type MatchingStrategy, FTS5Strategy, EmbeddingStrategy, DifflibStrategy } from './match';
export { deduplicate, type DedupInput, type DedupOutput, type DedupCommand } from './dedup';
export { confirm, type ConfirmInput, type ConfirmOutput, type LlmClient } from './confirm';
export { lookupPrices, getMarketPrice, type PriceInput, type PriceOutput, type PriceCommand, type PriceData, type PriceDimensions } from './price';
export { evaluate, type EvaluateInput, type EvaluateOutput, type EvaluateCommand, type OpportunityThresholds as LegacyOpportunityThresholds } from './evaluate';
export { store, type StoreInput, type StoreOutput, type StoreCommand } from './store';

// New taxonomy-driven pipeline building blocks.
export { extractUnconstrained, ruleBasedUnconstrainedExtract, type UnconstrainedExtractInput, type UnconstrainedExtractResult } from './extract_unconstrained';
export { classify, type ClassifyInput, type ClassifyResult, type GrowthEvent, type GrowthEventType } from './classify';
export { detectTier, type TierDetection } from './detect_tier';
export { processKnownProduct, type ProcessKnownInput, type ProcessKnownResult } from './process_known';
export { processCachedListing, type ProcessCachedInput, type ProcessCachedResult } from './process_cached';
export { validateFields, type ValidateFieldsInput, type ValidatedFields, type FieldValue } from './validate_fields';
export { resolveIdentity, type ResolveIdentityInput, type IdentityResolution, type IdentityMethod } from './resolve_identity';
export { persist, type PersistInput, type PersistResult } from './persist';
export { writePricePoint, type WritePricePointInput, type WritePricePointResult } from './write_price_point';
export { evaluateOpportunities, type EvaluateOpportunitiesInput, type OpportunityThresholds } from './evaluate_opportunities';
