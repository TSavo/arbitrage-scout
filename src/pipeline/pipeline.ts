/**
 * CommandPipeline — orchestrator for the taxonomy-driven arbitrage pipeline.
 *
 * Three speedrun tiers route incoming listings:
 *
 *   Tier 1 (external_id): adapter-supplied canonical ID → resolve product,
 *     persist + price + evaluate. Zero LLM.
 *   Tier 2 (cached): marketplace_listing_id previously seen with confirmed
 *     items → reuse products, re-evaluate at the new price. Zero LLM.
 *   Tier 3 (full_walk): novel listing → extract_unconstrained → classify
 *     (taxonomy walk) → validateFields → resolveIdentity → persist →
 *     writePricePoint → evaluateOpportunities.
 *
 * Every phase is an immutable transformation; the orchestrator threads
 * readonly values through phases and records a typed Command per phase.
 */

import { EventEmitter } from "events";
import { generateId } from "./utils";
import type {
  PipelineConfig,
  PipelineEvent,
  Command,
  Opportunity,
  RawListing,
  ValidatedListing,
  CommandIssuedEventData,
  OpportunityFoundEventData,
  HandlerErrorEventData,
} from "./types";
import { validate, type ValidationOutput } from "./commands/validate";
import {
  detectTier,
  type TierDetection,
} from "./commands/detect_tier";
import { processKnownProduct } from "./commands/process_known";
import { processCachedListing } from "./commands/process_cached";
import {
  extractUnconstrained,
  type UnconstrainedExtractResult,
} from "./commands/extract_unconstrained";
import { classify, type ClassifyResult } from "./commands/classify";
import {
  validateFields,
  type ValidatedFields,
} from "./commands/validate_fields";
import {
  resolveIdentity,
  type IdentityResolution,
} from "./commands/resolve_identity";
import { persist, type PersistResult } from "./commands/persist";
import { writePricePoint } from "./commands/write_price_point";
import {
  evaluateOpportunities,
  type OpportunityThresholds,
} from "./commands/evaluate_opportunities";
import { taxonomyRepo } from "@/db/repos/TaxonomyRepo";
import type { LlmClient } from "./commands/confirm";
import { eventBus } from "@/lib/events";

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

interface ValidateCmdInput {
  readonly listingId: string;
}
interface DetectTierCmdInput {
  readonly listingId: string;
}
interface ExtractCmdInput {
  readonly listingId: string;
  readonly fieldCount: number;
  readonly usedLlm: boolean;
}
interface ClassifyCmdInput {
  readonly listingId: string;
  readonly pathDepth: number;
}
interface ValidateFieldsCmdInput {
  readonly fieldCount: number;
  readonly invalidCount: number;
  readonly missingRequired: number;
}
interface ResolveIdentityCmdInput {
  readonly method: IdentityResolution["method"];
  readonly isNew: boolean;
}
interface PersistCmdInput {
  readonly productId: string;
  readonly isNewProduct: boolean;
  readonly isNewListing: boolean;
}
interface PricePointCmdInput {
  readonly productId: string;
  readonly source: string;
  readonly priceUsd: number;
}
interface EvaluateCmdInput {
  readonly productId: string;
  readonly opportunityCount: number;
}
interface FastPathCmdInput {
  readonly productId: string;
  readonly tier: "external_id" | "cached";
  readonly opportunityCount: number;
}

export class CommandPipeline {
  private readonly config: PipelineConfig;
  private readonly thresholds: OpportunityThresholds;
  private readonly emitter: EventEmitter;
  private readonly commands: Command[] = [];

  constructor(config: Partial<PipelineConfig> = {}) {
    this.config = {
      extractionBatchSize: config.extractionBatchSize ?? 20,
      matchingStrategies:
        config.matchingStrategies ?? ["fts5", "embedding", "difflib"],
      minProfitUsd: config.minProfitUsd ?? 25,
      minMarginPct: config.minMarginPct ?? 0.3,
      maxRetries: config.maxRetries ?? 3,
      llmUrl:
        config.llmUrl ??
        process.env.OLLAMA_URL ??
        "http://battleaxe:11434",
      llmModel:
        config.llmModel ?? process.env.OLLAMA_MODEL ?? "qwen3:8b",
    };
    this.thresholds = Object.freeze({
      minProfitUsd: this.config.minProfitUsd,
      minMarginPct: this.config.minMarginPct,
      feeRate: 0.15,
      shippingOutUsd: 5,
    });
    this.emitter = new EventEmitter();
  }

  /**
   * Legacy signature kept for back-compat: callers historically passed a
   * `schema` (ProductTypeSchema[]) as the 2nd argument. The new flow no
   * longer uses it; we accept-and-ignore to avoid a breaking change.
   */
  async processListing(
    raw: RawListing,
    schemaOrLlm?: unknown,
    maybeLlm?: LlmClient,
  ): Promise<ListingResult> {
    const llm = selectLlm(schemaOrLlm, maybeLlm);
    const listingCommands: Command[] = [];
    const start = Date.now();

    try {
      // ── Phase 0 — Validate sanity ───────────────────────────────
      const validationResult = validate({ listing: raw });
      this.pushCommand<ValidateCmdInput, ValidationOutput>(
        listingCommands,
        {
          id: generateId("val"),
          type: "validate",
          handler: "CommandPipeline",
          input: { listingId: raw.listingId },
          output: validationResult,
          timestamp: start,
          durationMs: 0,
        },
      );
      if (!validationResult.isValid) {
        this.commands.push(...listingCommands);
        return {
          listingId: raw.listingId,
          opportunities: [],
          commands: listingCommands,
        };
      }
      const validated: ValidatedListing = validationResult.listing;

      // ── Phase 1 — Tier detection ────────────────────────────────
      const tierStart = Date.now();
      const tier: TierDetection = await detectTier(validated);
      this.pushCommand<DetectTierCmdInput, TierDetection>(listingCommands, {
        id: generateId("tier"),
        type: "detect_tier",
        handler: "CommandPipeline",
        input: { listingId: validated.listingId },
        output: tier,
        timestamp: tierStart,
        durationMs: Date.now() - tierStart,
      });

      if (tier.kind === "external_id") {
        return this.finishFastPath(
          raw,
          listingCommands,
          await processKnownProduct({
            listing: validated,
            productId: tier.productId,
            thresholds: this.thresholds,
            ollamaUrl: this.config.llmUrl,
          }),
        );
      }

      if (tier.kind === "cached") {
        return this.finishFastPath(
          raw,
          listingCommands,
          await processCachedListing({
            listing: validated,
            existingListingId: tier.existingListingId,
            productIds: tier.productIds,
            thresholds: this.thresholds,
          }),
        );
      }

      // ── Phase 2 — Extract unconstrained ─────────────────────────
      const extractStart = Date.now();
      const extracted: UnconstrainedExtractResult = await extractUnconstrained({
        listing: validated,
        llmClient: llm,
      });
      this.pushCommand<ExtractCmdInput, UnconstrainedExtractResult>(
        listingCommands,
        {
          id: generateId("ext"),
          type: "extract",
          handler: "CommandPipeline",
          input: {
            listingId: validated.listingId,
            fieldCount: Object.keys(extracted.fields).length,
            usedLlm: extracted.usedLlm,
          },
          output: extracted,
          timestamp: extractStart,
          durationMs: Date.now() - extractStart,
        },
      );

      // ── Phase 3 — Classify (taxonomy walk) ──────────────────────
      const classifyStart = Date.now();
      const classified: ClassifyResult = await classify({
        listing: validated,
        extractedFields: extracted.fields,
        llmClient: llm,
      });
      this.pushCommand<ClassifyCmdInput, ClassifyResult>(listingCommands, {
        id: generateId("cls"),
        type: "classify",
        handler: "CommandPipeline",
        input: {
          listingId: validated.listingId,
          pathDepth: classified.path.length,
        },
        output: classified,
        timestamp: classifyStart,
        durationMs: Date.now() - classifyStart,
      });

      const leaf = classified.path[classified.path.length - 1];

      // ── Phase 4 — Validate fields against accumulated schema ────
      const vfStart = Date.now();
      const validatedFields: ValidatedFields = validateFields({
        extracted: extracted.fields,
        schema: classified.accumulatedSchema,
      });
      this.pushCommand<ValidateFieldsCmdInput, ValidatedFields>(
        listingCommands,
        {
          id: generateId("vf"),
          type: "validate_fields",
          handler: "CommandPipeline",
          input: {
            fieldCount: validatedFields.values.size,
            invalidCount: validatedFields.invalid.length,
            missingRequired: validatedFields.missingRequired.length,
          },
          output: validatedFields,
          timestamp: vfStart,
          durationMs: Date.now() - vfStart,
        },
      );

      // ── Phase 5 — Identity resolution ───────────────────────────
      const idStart = Date.now();
      const identity: IdentityResolution = await resolveIdentity({
        listing: validated,
        fields: validatedFields.values,
        node: leaf,
        schema: classified.accumulatedSchema,
        ollamaUrl: this.config.llmUrl,
      });
      this.pushCommand<ResolveIdentityCmdInput, IdentityResolution>(
        listingCommands,
        {
          id: generateId("rid"),
          type: "resolve_identity",
          handler: "CommandPipeline",
          input: { method: identity.method, isNew: identity.isNew },
          output: identity,
          timestamp: idStart,
          durationMs: Date.now() - idStart,
        },
      );

      // ── Phase 6 — Persist ───────────────────────────────────────
      const persistStart = Date.now();
      const stored: PersistResult = await persist({
        listing: validated,
        product: identity,
        fields: validatedFields.values,
        nodeId: leaf.id,
        schemaVersion: await taxonomyRepo.getCurrentSchemaVersion(),
        ollamaUrl: this.config.llmUrl,
        confirmed: identity.method !== "new",
      });
      this.pushCommand<PersistCmdInput, PersistResult>(listingCommands, {
        id: generateId("per"),
        type: "persist",
        handler: "CommandPipeline",
        input: {
          productId: stored.productId,
          isNewProduct: stored.isNewProduct,
          isNewListing: stored.isNewListing,
        },
        output: stored,
        timestamp: persistStart,
        durationMs: Date.now() - persistStart,
      });

      // ── Phase 7 — Write price_point ─────────────────────────────
      const priceStart = Date.now();
      const priceResult = await writePricePoint({
        productId: stored.productId,
        source: validated.marketplaceId,
        priceUsd: validated.priceUsd,
        fields: validatedFields.values,
        schema: classified.accumulatedSchema,
      });
      this.pushCommand<PricePointCmdInput, typeof priceResult>(
        listingCommands,
        {
          id: generateId("pp"),
          type: "price",
          handler: "CommandPipeline",
          input: {
            productId: stored.productId,
            source: validated.marketplaceId,
            priceUsd: validated.priceUsd,
          },
          output: priceResult,
          timestamp: priceStart,
          durationMs: Date.now() - priceStart,
        },
      );

      // ── Phase 8 — Evaluate ──────────────────────────────────────
      const evalStart = Date.now();
      const opps = await evaluateOpportunities({
        listingDbId: stored.listingId,
        listingMarketplaceId: validated.marketplaceId,
        productId: stored.productId,
        listingPrice: validated.priceUsd,
        shippingUsd: validated.shippingUsd,
        node: leaf,
        schema: classified.accumulatedSchema,
        fields: validatedFields.values,
        thresholds: this.thresholds,
      });
      this.pushCommand<EvaluateCmdInput, { readonly opportunities: readonly Opportunity[] }>(
        listingCommands,
        {
          id: generateId("eva"),
          type: "evaluate",
          handler: "CommandPipeline",
          input: {
            productId: stored.productId,
            opportunityCount: opps.length,
          },
          output: { opportunities: opps },
          timestamp: evalStart,
          durationMs: Date.now() - evalStart,
        },
      );

      // ── Phase 9 — Emit ──────────────────────────────────────────
      for (const opp of opps) {
        this.emitOpportunityFound(raw.listingId, opp);
      }

      this.commands.push(...listingCommands);
      return {
        listingId: raw.listingId,
        opportunities: opps,
        commands: listingCommands,
      };
    } catch (err) {
      this.emitError("processListing", err);
      this.commands.push(...listingCommands);
      throw err;
    }
  }

  private finishFastPath(
    raw: RawListing,
    listingCommands: Command[],
    result: {
      readonly listingId: number;
      readonly productId?: string;
      readonly opportunities: readonly Opportunity[];
      readonly tier: "external_id" | "cached";
    },
  ): ListingResult {
    this.pushCommand<FastPathCmdInput, {
      readonly listingId: number;
      readonly opportunities: readonly Opportunity[];
    }>(listingCommands, {
      id: generateId("fpc"),
      type: "fast_path",
      handler: "CommandPipeline",
      input: {
        productId: result.productId ?? "",
        tier: result.tier,
        opportunityCount: result.opportunities.length,
      },
      output: {
        listingId: result.listingId,
        opportunities: result.opportunities,
      },
      timestamp: Date.now(),
      durationMs: 0,
    });

    for (const opp of result.opportunities) {
      this.emitOpportunityFound(raw.listingId, opp);
    }

    this.commands.push(...listingCommands);
    return {
      listingId: raw.listingId,
      opportunities: result.opportunities,
      commands: listingCommands,
    };
  }

  onEvent(callback: (event: PipelineEvent) => void): () => void {
    const handlerFor =
      (type: PipelineEvent["type"]) =>
      (data: Record<string, unknown>) => {
        const handler =
          typeof data.handler === "string" ? data.handler : "CommandPipeline";
        const timestamp =
          typeof data.timestamp === "number" ? data.timestamp : Date.now();
        callback({ type, handler, timestamp, data });
      };

    const issued = handlerFor("command.issued");
    const found = handlerFor("opportunity.found");
    const errored = handlerFor("handler.error");

    this.emitter.on("command.issued", issued);
    this.emitter.on("opportunity.found", found);
    this.emitter.on("handler.error", errored);

    return () => {
      this.emitter.off("command.issued", issued);
      this.emitter.off("opportunity.found", found);
      this.emitter.off("handler.error", errored);
    };
  }

  getMetrics(): PipelineMetrics {
    let totalItems = 0;
    let totalOpportunities = 0;

    for (const c of this.commands) {
      if (c.type === "validate_fields") {
        const out = c.output as ValidatedFields | undefined;
        totalItems += out?.values?.size ?? 0;
      } else if (c.type === "evaluate") {
        const out = c.output as { opportunities?: readonly Opportunity[] } | undefined;
        totalOpportunities += out?.opportunities?.length ?? 0;
      } else if (c.type === "fast_path") {
        const out = c.output as
          | { opportunities?: readonly Opportunity[] }
          | undefined;
        totalOpportunities += out?.opportunities?.length ?? 0;
      }
    }

    return {
      totalListings: this.commands.filter((c) => c.type === "validate").length,
      totalItems,
      totalOpportunities,
      totalErrors: this.commands.filter((c) => c.error).length,
      totalTimeMs: this.commands.reduce((s, c) => s + c.durationMs, 0),
      commands: [...this.commands],
    };
  }

  getEmitter(): EventEmitter {
    return this.emitter;
  }

  private pushCommand<TInput, TOutput>(
    bucket: Command[],
    cmd: Command<TInput, TOutput>,
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
    this.emitter.emit("command.issued", {
      ...data,
      timestamp: cmd.timestamp,
    });
    eventBus.emitScoutEvent({
      type: "log",
      source: "pipeline",
      message: `${cmd.type} (${cmd.durationMs}ms)`,
      data: {
        ...data,
        timestamp: cmd.timestamp,
      } as unknown as Record<string, unknown>,
      timestamp: new Date(cmd.timestamp).toISOString(),
    });
  }

  private emitOpportunityFound(
    listingId: string,
    opportunity: Opportunity,
  ): void {
    const data: OpportunityFoundEventData = {
      handler: "CommandPipeline",
      listingId,
      opportunity,
    };
    this.emitter.emit("opportunity.found", {
      ...data,
      timestamp: Date.now(),
    });
    eventBus.emitScoutEvent({
      type: "opportunity",
      source: "pipeline",
      message: `${opportunity.productTitle || opportunity.productId} profit=$${opportunity.profit.toFixed(
        2,
      )} margin=${(opportunity.margin * 100).toFixed(0)}%`,
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
    this.emitter.emit("handler.error", { ...data, timestamp: Date.now() });
    eventBus.emitScoutEvent({
      type: "error",
      source: "pipeline",
      message: `${handler}: ${message}`,
      data: data as unknown as Record<string, unknown>,
      timestamp: new Date().toISOString(),
    });
  }
}

function selectLlm(a: unknown, b: unknown): LlmClient | undefined {
  // Back-compat: callers sometimes pass (raw, schema, llm), sometimes (raw, llm).
  if (isLlmClient(a)) return a;
  if (isLlmClient(b)) return b;
  return undefined;
}

function isLlmClient(v: unknown): v is LlmClient {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { generateJson?: unknown }).generateJson === "function"
  );
}
