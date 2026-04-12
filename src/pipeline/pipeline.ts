import { EventEmitter } from 'events';
import { generateId } from './utils';
import type {
  PipelineConfig,
  PipelineEvent,
  Command,
  Opportunity,
  RawListing,
  CatalogMatch,
  ValidatedListing,
  ExtractedItem,
  CommandIssuedEventData,
  OpportunityFoundEventData,
  HandlerErrorEventData,
} from './types';
import { validate, type ValidationOutput } from './commands/validate';
import { ruleBasedExtract, llmExtract } from './commands/extract';
import type { ExtractOutput } from './commands/extract';
import { match, type MatchOutput } from './commands/match';
import { deduplicate, type DedupOutput } from './commands/dedup';
import { confirm, type ConfirmOutput } from './commands/confirm';
import { lookupPrices, type PriceOutput } from './commands/price';
import { evaluate, type EvaluateOutput, type OpportunityThresholds } from './commands/evaluate';
import { store, type StoreOutput } from './commands/store';
import type { ProductTypeSchema } from './commands/extract';
import type { PriceDimensions } from './commands/price';
import type { LlmClient } from './commands/confirm';
import { db } from '@/db/client';
import { listings, listingItems, pricePoints } from '@/db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { eventBus } from '@/lib/events';

export interface PipelineMetrics {
  readonly totalListings: number;
  readonly totalItems: number;
  readonly totalOpportunities: number;
  readonly totalErrors: number;
  readonly totalTimeMs: number;
  readonly commands: readonly Command[];
}

export interface ListingResult {
  readonly listingId: string;
  readonly opportunities: readonly Opportunity[];
  readonly commands: readonly Command[];
}

interface ValidateCmdInput { readonly listingId: string; }
interface ExtractCmdInput { readonly listingId: string; readonly itemCount: number; readonly usedLlm: boolean; }
interface MatchCmdInput { readonly itemCount: number; }
interface DedupCmdInput { readonly itemCount: number; }
interface ConfirmCmdInput { readonly confirmedItems: number; readonly usedLlm: boolean; }
interface PriceCmdInput { readonly matchCount: number; }
interface EvaluateCmdInput { readonly opportunityCount: number; }
interface StoreCmdInput {
  readonly opportunityCount: number;
  readonly itemCount: number;
}
interface StoreCmdOutput {
  readonly listingDbId: number;
  readonly itemsStored: number;
  readonly opportunitiesStored: number;
  readonly opportunityIds: readonly string[];
}
interface ReevaluateCmdInput { readonly itemCount: number; }
interface ReevaluateCmdOutput { readonly opportunityCount: number; }
interface FastPathCmdInput { readonly productId: string; readonly condition: string; }
interface FastPathCmdOutput {
  readonly price: number;
  readonly profit: number;
  readonly margin: number;
  readonly meetsThreshold: boolean;
}

export class CommandPipeline {
  private config: PipelineConfig;
  private emitter: EventEmitter;
  private commands: Command[] = [];

  constructor(config: Partial<PipelineConfig> = {}) {
    this.config = {
      extractionBatchSize: config.extractionBatchSize ?? 20,
      matchingStrategies: config.matchingStrategies ?? ['fts5', 'embedding', 'difflib'],
      minProfitUsd: config.minProfitUsd ?? 25,
      minMarginPct: config.minMarginPct ?? 0.30,
      maxRetries: config.maxRetries ?? 3,
      llmUrl: config.llmUrl ?? process.env.OLLAMA_URL ?? 'http://battleaxe:11434',
      llmModel: config.llmModel ?? process.env.OLLAMA_MODEL ?? 'qwen3:8b',
    };
    this.emitter = new EventEmitter();
  }

  async processListing(
    raw: RawListing,
    schema: ProductTypeSchema[],
    _llmClient?: LlmClient
  ): Promise<ListingResult> {
    const listingCommands: Command[] = [];
    const start = Date.now();

    try {
      const validationResult = validate({ listing: raw });
      this.pushCommand<ValidateCmdInput, ValidationOutput>(listingCommands, {
        id: generateId('val'),
        type: 'validate',
        handler: 'CommandPipeline',
        input: { listingId: raw.listingId },
        output: validationResult,
        timestamp: start,
        durationMs: 0,
      });

      if (!validationResult.isValid) {
        this.commands.push(...listingCommands);
        return { listingId: raw.listingId, opportunities: [], commands: listingCommands };
      }

      const validated: ValidatedListing = validationResult.listing;

      const pcProductId = typeof raw.extra?.pc_product_id === 'string' ? raw.extra.pc_product_id : undefined;
      if (pcProductId) {
        return await this.processKnownProduct(raw, pcProductId, listingCommands, start);
      }

      const existingItems = await this.checkExistingItems(raw);
      if (existingItems) {
        return await this.processExistingItems(raw, existingItems, listingCommands, start);
      }

      const extractStart = Date.now();
      const useLlm = Boolean(_llmClient);

      const extractResult: ExtractOutput = useLlm
        ? await llmExtract({ listing: validated, schema }, this.config.llmUrl, this.config.llmModel)
        : ruleBasedExtract({ listing: validated, schema });

      this.pushCommand<ExtractCmdInput, ExtractOutput>(listingCommands, {
        id: generateId('ext'),
        type: 'extract',
        handler: 'CommandPipeline',
        input: { listingId: raw.listingId, itemCount: extractResult.items.length, usedLlm: extractResult.usedLlm },
        output: extractResult,
        timestamp: extractStart,
        durationMs: Date.now() - extractStart,
      });

      if (extractResult.items.length === 0) {
        this.commands.push(...listingCommands);
        return { listingId: raw.listingId, opportunities: [], commands: listingCommands };
      }

      const matchStart = Date.now();
      const matchResult: MatchOutput = await match({
        items: extractResult.items,
        useEmbedding: true,
        ollamaUrl: this.config.llmUrl,
        schema,
      });
      this.pushCommand<MatchCmdInput, MatchOutput>(listingCommands, {
        id: generateId('mat'),
        type: 'match',
        handler: 'CommandPipeline',
        input: { itemCount: extractResult.items.length },
        output: matchResult,
        timestamp: matchStart,
        durationMs: Date.now() - matchStart,
      });

      const dedupStart = Date.now();
      const dedupResult: DedupOutput = deduplicate({
        items: extractResult.items,
        candidates: matchResult.candidates,
      });
      this.pushCommand<DedupCmdInput, DedupOutput>(listingCommands, {
        id: generateId('ded'),
        type: 'dedup',
        handler: 'CommandPipeline',
        input: { itemCount: extractResult.items.length },
        output: dedupResult,
        timestamp: dedupStart,
        durationMs: Date.now() - dedupStart,
      });

      const confirmStart = Date.now();
      const confirmResult: ConfirmOutput = await confirm({
        items: extractResult.items,
        candidates: dedupResult.candidates,
        listingPrice: validated.priceUsd,
        useLlm,
        llmClient: _llmClient,
      });
      this.pushCommand<ConfirmCmdInput, ConfirmOutput>(listingCommands, {
        id: generateId('con'),
        type: 'confirm',
        handler: 'CommandPipeline',
        input: { confirmedItems: confirmResult.confirmedCount, usedLlm: useLlm },
        output: confirmResult,
        timestamp: confirmStart,
        durationMs: Date.now() - confirmStart,
      });

      // Build per-item pricing dimensions from pricing-axis fields in the
      // matched product type schema. This is how bourbon (no axes) and sports
      // cards (condition + grade + grading_company) share the same pipeline.
      const dimensionsByIdx = new Map<number, PriceDimensions>();
      for (let i = 0; i < extractResult.items.length; i++) {
        const item = extractResult.items[i];
        const pt = schema.find((s) => s.id === item.productType);
        if (!pt) continue;
        const dims: Record<string, string | number | boolean> = {};
        for (const f of pt.fields) {
          if (!f.isPricingAxis) continue;
          const v = item.metadata?.[f.key];
          if (v !== undefined && v !== null && v !== '') {
            dims[f.key] = v;
          }
        }
        if (Object.keys(dims).length) {
          dimensionsByIdx.set(i, Object.freeze(dims));
        }
      }

      const priceStart = Date.now();
      const priceResult: PriceOutput = await lookupPrices({
        matches: confirmResult.matches,
        dimensions: dimensionsByIdx as ReadonlyMap<number, PriceDimensions>,
      });
      const matchCount = Array.from(confirmResult.matches.values()).filter((m): m is CatalogMatch => m !== null).length;
      this.pushCommand<PriceCmdInput, PriceOutput>(listingCommands, {
        id: generateId('pri'),
        type: 'price',
        handler: 'CommandPipeline',
        input: { matchCount },
        output: priceResult,
        timestamp: priceStart,
        durationMs: Date.now() - priceStart,
      });

      const thresholds: OpportunityThresholds = {
        minProfitUsd: this.config.minProfitUsd,
        minMarginPct: this.config.minMarginPct,
        feeRate: 0.15,
        shippingOutUsd: 5,
      };

      const confirmedIndices = new Set<number>();
      for (let i = 0; i < extractResult.items.length; i++) {
        if (confirmResult.matches.get(i)) {
          confirmedIndices.add(i);
        }
      }

      const evalStart = Date.now();
      const evaluateResult: EvaluateOutput = evaluate({
        listing: validated,
        matches: confirmResult.matches,
        prices: priceResult.prices,
        confirmedIndices,
        thresholds,
        dimensions: dimensionsByIdx as ReadonlyMap<number, PriceDimensions>,
      });
      this.pushCommand<EvaluateCmdInput, EvaluateOutput>(listingCommands, {
        id: generateId('eva'),
        type: 'evaluate',
        handler: 'CommandPipeline',
        input: { opportunityCount: evaluateResult.opportunities.length },
        output: evaluateResult,
        timestamp: evalStart,
        durationMs: Date.now() - evalStart,
      });

      if (evaluateResult.opportunities.length > 0 || extractResult.items.length > 0) {
        const storeStart = Date.now();
        const storeResult: StoreOutput = await store({
          listingId: raw.listingId,
          marketplaceId: raw.marketplaceId,
          marketplaceListingId: raw.listingId,
          title: raw.title,
          url: raw.url,
          priceUsd: raw.priceUsd,
          shippingUsd: raw.shippingUsd,
          seller: raw.seller,
          items: extractResult.items,
          matches: confirmResult.matches,
          topCandidates: buildTopCandidates(dedupResult.candidates),
          opportunities: evaluateResult.opportunities,
          validatedAt: validated.validatedAt,
          ollamaUrl: this.config.llmUrl,
        });

        const structuredOutput: StoreCmdOutput = {
          listingDbId: storeResult.listingDbId,
          itemsStored: storeResult.itemsStored,
          opportunitiesStored: storeResult.opportunitiesStored,
          opportunityIds: evaluateResult.opportunities.map(o => o.id),
        };

        this.pushCommand<StoreCmdInput, StoreCmdOutput>(listingCommands, {
          id: generateId('sto'),
          type: 'store',
          handler: 'CommandPipeline',
          input: { opportunityCount: evaluateResult.opportunities.length, itemCount: extractResult.items.length },
          output: structuredOutput,
          timestamp: storeStart,
          durationMs: Date.now() - storeStart,
        });

        for (const opp of evaluateResult.opportunities) {
          this.emitOpportunityFound(raw.listingId, opp);
        }
      }

      this.commands.push(...listingCommands);
      return { listingId: raw.listingId, opportunities: evaluateResult.opportunities, commands: listingCommands };
    } catch (err) {
      this.emitError('processListing', err);
      throw err;
    }
  }

  private async checkExistingItems(raw: RawListing): Promise<Array<{ productId: string; condition: string; confidence: number; confirmed: boolean }> | null> {
    const listing = await db.query.listings.findFirst({
      where: and(
        eq(listings.marketplaceId, raw.marketplaceId),
        eq(listings.marketplaceListingId, raw.listingId),
      ),
      columns: { id: true },
    });

    if (!listing) return null;

    const items = await db.query.listingItems.findMany({
      where: eq(listingItems.listingId, listing.id),
      columns: {
        productId: true,
        condition: true,
        confidence: true,
        confirmed: true,
      },
    });

    if (items.length === 0) return null;

    return items.map(row => ({
      productId: row.productId,
      condition: row.condition,
      confidence: row.confidence,
      confirmed: Boolean(row.confirmed),
    }));
  }

  private async processExistingItems(
    raw: RawListing,
    existingItems: Array<{ productId: string; condition: string; confidence: number; confirmed: boolean }>,
    commands: Command[],
    start: number
  ): Promise<ListingResult> {
    const confirmedItems = existingItems.filter(i => i.confirmed);
    if (!confirmedItems.length) {
      this.commands.push(...commands);
      return { listingId: raw.listingId, opportunities: [], commands };
    }

    const opportunities: Opportunity[] = [];
    const thresholds: OpportunityThresholds = {
      minProfitUsd: this.config.minProfitUsd,
      minMarginPct: this.config.minMarginPct,
      feeRate: 0.15,
      shippingOutUsd: 5,
    };

    for (const item of confirmedItems) {
      const price = await this.getMarketPrice(item.productId, item.condition);
      if (!price || price <= 0) continue;

      const cost = (raw.priceUsd + raw.shippingUsd) / confirmedItems.length;
      const profit = price * (1 - thresholds.feeRate) - cost - thresholds.shippingOutUsd;
      const margin = cost > 0 ? profit / cost : 0;

      if (profit < thresholds.minProfitUsd || margin < thresholds.minMarginPct) continue;

      opportunities.push({
        id: generateId('opp'),
        listingId: '',
        productId: item.productId,
        productTitle: '',
        condition: item.condition,
        priceDimensions: Object.freeze(
          (item.condition ? { condition: item.condition } : {}) as Record<string, string>,
        ),
        marketPrice: price,
        cost,
        profit,
        margin,
        flags: {
          auctionMayIncrease: (raw.numBids ?? 0) > 0,
          verifyAuthenticity: margin >= 2.0,
          isLot: confirmedItems.length > 1,
        },
        confidence: item.confidence,
        createdAt: start,
      });
    }

    const reexCmd: Command<ReevaluateCmdInput, ReevaluateCmdOutput> = {
      id: generateId('rex'),
      type: 'reevaluate',
      handler: 'CommandPipeline',
      input: { itemCount: confirmedItems.length },
      output: { opportunityCount: opportunities.length },
      timestamp: start,
      durationMs: Date.now() - start,
    };
    this.pushCommand<ReevaluateCmdInput, ReevaluateCmdOutput>(commands, reexCmd);

    for (const opp of opportunities) {
      this.emitOpportunityFound(raw.listingId, opp);
    }

    this.commands.push(...commands);
    return { listingId: raw.listingId, opportunities, commands };
  }

  private async processKnownProduct(
    raw: RawListing,
    pcProductId: string,
    commands: Command[],
    start: number
  ): Promise<ListingResult> {
    const includeField = typeof raw.extra?.include === 'string' ? raw.extra.include : '';
    const condition = includeField.toLowerCase().includes('only') ? 'loose' : 'cib';
    const price = await this.getMarketPrice(pcProductId, condition);

    if (!price || price <= 0) {
      this.commands.push(...commands);
      return { listingId: raw.listingId, opportunities: [], commands };
    }

    const cost = raw.priceUsd + raw.shippingUsd;
    const profit = price * 0.85 - cost - 5;
    const margin = cost > 0 ? profit / cost : 0;

    const fastCmd: Command<FastPathCmdInput, FastPathCmdOutput> = {
      id: generateId('fpc'),
      type: 'fast_path',
      handler: 'CommandPipeline',
      input: { productId: pcProductId, condition },
      output: { price, profit, margin, meetsThreshold: profit >= 25 && margin >= 0.3 },
      timestamp: start,
      durationMs: Date.now() - start,
    };
    this.pushCommand<FastPathCmdInput, FastPathCmdOutput>(commands, fastCmd);

    if (profit < 25 || margin < 0.3) {
      this.commands.push(...commands);
      return { listingId: raw.listingId, opportunities: [], commands };
    }

    const opportunities: Opportunity[] = [{
      id: generateId('opp'),
      listingId: '',
      productId: pcProductId,
      productTitle: '',
      condition,
      priceDimensions: Object.freeze({ condition }),
      marketPrice: price,
      cost,
      profit,
      margin,
      flags: {
        auctionMayIncrease: false,
        verifyAuthenticity: false,
        isLot: false,
      },
      confidence: 0.9,
      createdAt: start,
    }];

    for (const opp of opportunities) {
      this.emitOpportunityFound(raw.listingId, opp);
    }

    this.commands.push(...commands);
    return { listingId: raw.listingId, opportunities, commands };
  }

  private async getMarketPrice(productId: string, condition: string): Promise<number | null> {
    const rows = await db
      .select({ priceUsd: pricePoints.priceUsd })
      .from(pricePoints)
      .where(and(eq(pricePoints.productId, productId), eq(pricePoints.condition, condition)))
      .orderBy(desc(pricePoints.recordedAt))
      .limit(1)
      .all();

    if (rows.length > 0) return rows[0].priceUsd;

    if (condition !== 'loose') {
      const fallback = await db
        .select({ priceUsd: pricePoints.priceUsd })
        .from(pricePoints)
        .where(and(eq(pricePoints.productId, productId), eq(pricePoints.condition, 'loose')))
        .orderBy(desc(pricePoints.recordedAt))
        .limit(1)
        .all();
      return fallback[0]?.priceUsd ?? null;
    }

    return null;
  }

  onEvent(callback: (event: PipelineEvent) => void): () => void {
    const handlerFor = (type: PipelineEvent['type']) => (data: Record<string, unknown>) => {
      const handler = typeof data.handler === 'string' ? data.handler : 'CommandPipeline';
      const timestamp = typeof data.timestamp === 'number' ? data.timestamp : Date.now();
      callback({ type, handler, timestamp, data });
    };

    const issued = handlerFor('command.issued');
    const found = handlerFor('opportunity.found');
    const errored = handlerFor('handler.error');

    this.emitter.on('command.issued', issued);
    this.emitter.on('opportunity.found', found);
    this.emitter.on('handler.error', errored);

    return () => {
      this.emitter.off('command.issued', issued);
      this.emitter.off('opportunity.found', found);
      this.emitter.off('handler.error', errored);
    };
  }

  getMetrics(): PipelineMetrics {
    let totalItems = 0;
    let totalOpportunities = 0;

    for (const c of this.commands) {
      if (c.type === 'extract') {
        const out = c.output as ExtractOutput | undefined;
        totalItems += out?.items?.length ?? 0;
      } else if (c.type === 'evaluate') {
        const out = c.output as EvaluateOutput | undefined;
        totalOpportunities += out?.opportunities?.length ?? 0;
      } else if (c.type === 'fast_path') {
        const out = c.output as FastPathCmdOutput | undefined;
        if (out?.meetsThreshold) totalOpportunities += 1;
      } else if (c.type === 'reevaluate') {
        const out = c.output as ReevaluateCmdOutput | undefined;
        totalOpportunities += out?.opportunityCount ?? 0;
      }
    }

    return {
      totalListings: this.commands.filter(c => c.type === 'validate').length,
      totalItems,
      totalOpportunities,
      totalErrors: this.commands.filter(c => c.error).length,
      totalTimeMs: this.commands.reduce((sum, c) => sum + c.durationMs, 0),
      commands: [...this.commands],
    };
  }

  getEmitter(): EventEmitter {
    return this.emitter;
  }

  private pushCommand<TInput, TOutput>(
    bucket: Command[],
    cmd: Command<TInput, TOutput>
  ): void {
    bucket.push(cmd as Command);
    const data: CommandIssuedEventData = {
      handler: cmd.handler,
      commandType: cmd.type,
      commandId: cmd.id,
      durationMs: cmd.durationMs,
      input: cmd.input,
      output: cmd.output,
    };
    this.emitter.emit('command.issued', { ...data, timestamp: cmd.timestamp });
    eventBus.emitScoutEvent({
      type: 'log',
      source: 'pipeline',
      message: `${cmd.type} (${cmd.durationMs}ms)`,
      data: { ...data, timestamp: cmd.timestamp } as unknown as Record<string, unknown>,
      timestamp: new Date(cmd.timestamp).toISOString(),
    });
  }

  private emitOpportunityFound(listingId: string, opportunity: Opportunity): void {
    const data: OpportunityFoundEventData = {
      handler: 'CommandPipeline',
      listingId,
      opportunity,
    };
    this.emitter.emit('opportunity.found', { ...data, timestamp: Date.now() });
    eventBus.emitScoutEvent({
      type: 'opportunity',
      source: 'pipeline',
      message: `${opportunity.productTitle || opportunity.productId} profit=$${opportunity.profit.toFixed(2)} margin=${(opportunity.margin * 100).toFixed(0)}%`,
      data: {
        listingId,
        productId: opportunity.productId,
        productTitle: opportunity.productTitle,
        profit: opportunity.profit,
        margin: opportunity.margin,
        marketPrice: opportunity.marketPrice,
        cost: opportunity.cost,
      },
      timestamp: new Date().toISOString(),
    });
  }

  private emitError(handler: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    const data: HandlerErrorEventData = {
      handler,
      error: message,
    };
    this.emitter.emit('handler.error', { ...data, timestamp: Date.now() });
    eventBus.emitScoutEvent({
      type: 'error',
      source: 'pipeline',
      message: `${handler}: ${message}`,
      data: data as unknown as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
  }
}

function buildTopCandidates(
  candidates: ReadonlyMap<number, readonly CatalogMatch[]>
): ReadonlyMap<number, CatalogMatch | null> {
  const result = new Map<number, CatalogMatch | null>();
  for (const [idx, cands] of candidates) {
    result.set(idx, cands.length > 0 ? cands[0] : null);
  }
  return result;
}
