/**
 * LlmPool — a set of LLM providers that the pipeline calls as if it were
 * one `LlmClient`. Each provider serializes its own traffic (one in-flight
 * call per provider, enforced by cachedFetch's serializeKey mutex). With
 * N providers configured, the pipeline can have N concurrent LLM calls.
 *
 * Routing policy: pick the provider with the fewest in-flight requests at
 * the moment of the call. Ties broken by the provider's declared priority
 * (local Ollama prefers over paid/rate-limited remotes).
 *
 * The pool implements the same `LlmClient.generateJson(prompt, opts)`
 * interface the pipeline already uses, so classify/extract drop-in.
 */

import { cachedFetch } from "@/lib/cached_fetch";
import { log, error as logError } from "@/lib/logger";

export interface LlmClient {
  generateJson(prompt: string, opts?: { system?: string }): Promise<unknown>;
}

export interface LlmProviderConfig {
  readonly name: string;
  /** Fully qualified endpoint: e.g. "http://battleaxe:11434/api/generate". */
  readonly url: string;
  /** Build the POST body for a given prompt + system. */
  readonly buildBody: (prompt: string, system?: string) => unknown;
  /** Extract the generated text from the parsed JSON response. */
  readonly extractText: (json: unknown) => string;
  /** Additional headers (auth, content-type). */
  readonly headers?: Record<string, string>;
  /**
   * cachedFetch serializeKey — one in-flight per key. Pool size = number
   * of distinct serializeKeys; two providers sharing a key share a queue.
   */
  readonly serializeKey: string;
  /** Lower = preferred when tied on queue depth. */
  readonly priority?: number;
}

class Provider implements LlmClient {
  private _inFlight = 0;
  readonly name: string;
  readonly priority: number;
  readonly serializeKey: string;

  constructor(private readonly cfg: LlmProviderConfig) {
    this.name = cfg.name;
    this.priority = cfg.priority ?? 0;
    this.serializeKey = cfg.serializeKey;
  }

  get inFlight(): number {
    return this._inFlight;
  }

  async generateJson(prompt: string, opts: { system?: string } = {}): Promise<unknown> {
    this._inFlight++;
    try {
      const body = this.cfg.buildBody(prompt, opts.system);
      const resp = await cachedFetch(
        this.cfg.url,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(this.cfg.headers ?? {}),
          },
          body: JSON.stringify(body),
        },
        {
          ttlMs: null,
          cacheTag: `llm:${this.name}`,
          serializeKey: this.cfg.serializeKey,
        },
      );
      if (!resp.ok) {
        throw new Error(`${this.name} HTTP ${resp.status}: ${resp.body.slice(0, 200)}`);
      }
      const data = resp.json<unknown>();
      const text = this.cfg.extractText(data);
      return parseJsonBlob(text);
    } finally {
      this._inFlight--;
    }
  }
}

const FENCE_RE = /```(?:json)?\s*([\s\S]+?)\s*```/i;
const OBJECT_RE = /(\{[\s\S]*\}|\[[\s\S]*\])/;
function parseJsonBlob(text: string): unknown {
  const trimmed = text.trim();
  const fence = FENCE_RE.exec(trimmed);
  if (fence) return JSON.parse(fence[1].trim());
  const obj = OBJECT_RE.exec(trimmed);
  if (obj) return JSON.parse(obj[1]);
  return JSON.parse(trimmed);
}

export class LlmPool implements LlmClient {
  private readonly providers: ReadonlyArray<Provider>;

  constructor(configs: ReadonlyArray<LlmProviderConfig>) {
    if (configs.length === 0) throw new Error("LlmPool: need at least one provider");
    this.providers = configs.map((c) => new Provider(c));
    log(
      "llm-pool",
      `configured with ${this.providers.length} provider(s): ${this.providers.map((p) => p.name).join(", ")}`,
    );
  }

  /** Concurrency capacity = distinct serializeKeys. Providers sharing a
   *  key share a rate-limit slot (e.g. 3 OpenRouter models share one
   *  20/min bucket) and should only contribute one slot of parallelism. */
  get size(): number {
    return new Set(this.providers.map((p) => p.serializeKey)).size;
  }

  private pick(): Provider {
    // Compute in-flight per serializeKey (sum across providers sharing it)
    // so we don't load up one shared-key group while another is idle.
    const byKey = new Map<string, number>();
    for (const p of this.providers) {
      byKey.set(p.serializeKey, (byKey.get(p.serializeKey) ?? 0) + p.inFlight);
    }
    // Sort providers by their key's total in-flight, then priority.
    return [...this.providers].sort((a, b) => {
      const ka = byKey.get(a.serializeKey)!;
      const kb = byKey.get(b.serializeKey)!;
      if (ka !== kb) return ka - kb;
      return a.priority - b.priority;
    })[0];
  }

  async generateJson(prompt: string, opts: { system?: string } = {}): Promise<unknown> {
    // Try each provider in pick-order; on failure, fall back to the next.
    // Providers that share a serializeKey are only tried once (no point
    // hammering the same rate-limited bucket).
    const tried = new Set<string>();
    const byKey = new Map<string, number>();
    for (const p of this.providers) {
      byKey.set(p.serializeKey, (byKey.get(p.serializeKey) ?? 0) + p.inFlight);
    }
    const ordered = [...this.providers].sort((a, b) => {
      const ka = byKey.get(a.serializeKey)!;
      const kb = byKey.get(b.serializeKey)!;
      if (ka !== kb) return ka - kb;
      return a.priority - b.priority;
    });

    let lastErr: unknown;
    for (const p of ordered) {
      if (tried.has(p.serializeKey)) continue;
      tried.add(p.serializeKey);
      try {
        return await p.generateJson(prompt, opts);
      } catch (err) {
        lastErr = err;
        logError(
          "llm-pool",
          `${p.name} failed (${(err as Error).message.slice(0, 80)}), trying next provider`,
        );
      }
    }
    throw lastErr ?? new Error("llm-pool: all providers exhausted");
  }
}

// ── concrete providers ─────────────────────────────────────────────────────

export function ollamaProvider(opts: {
  readonly baseUrl?: string;
  readonly model?: string;
}): LlmProviderConfig {
  const baseUrl = (opts.baseUrl ?? "http://battleaxe:11434").replace(/\/$/, "");
  const model = opts.model ?? "qwen3:8b";
  return {
    name: `ollama:${model}`,
    url: `${baseUrl}/api/generate`,
    serializeKey: "ollama",
    priority: 0,
    buildBody: (prompt, system) => ({
      model,
      prompt,
      stream: false,
      think: false,
      options: { temperature: 0 },
      ...(system ? { system } : {}),
    }),
    extractText: (raw) => {
      const d = raw as { response?: string };
      if (typeof d.response !== "string") throw new Error("ollama: no response field");
      return d.response;
    },
  };
}

export function openRouterProvider(opts: {
  readonly apiKey: string;
  readonly model: string;
  /** Optional override for display name / mutex key. */
  readonly name?: string;
  readonly priority?: number;
}): LlmProviderConfig {
  const name = opts.name ?? `openrouter:${opts.model}`;
  return {
    name,
    url: "https://openrouter.ai/api/v1/chat/completions",
    // All OpenRouter free-tier calls share ONE 20/min rate-limit bucket
    // regardless of model. Use a single serializeKey so the mutex
    // coordinates across all providers (see MIN_GAP_MS for pacing).
    serializeKey: "openrouter",
    priority: opts.priority ?? 10, // Prefer Ollama by default.
    headers: {
      Authorization: `Bearer ${opts.apiKey}`,
      "HTTP-Referer": "https://arbitrage-scout.local",
      "X-Title": "arbitrage-scout",
    },
    buildBody: (prompt, system) => ({
      model: opts.model,
      messages: [
        ...(system ? [{ role: "system", content: system }] : []),
        { role: "user", content: prompt },
      ],
      temperature: 0,
    }),
    extractText: (raw) => {
      const d = raw as { choices?: Array<{ message?: { content?: string } }> };
      const content = d.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new Error("openrouter: no choices[0].message.content");
      return content;
    },
  };
}

/**
 * Build the default pool from env:
 *   - Ollama always (battleaxe)
 *   - OpenRouter free models, if OPENROUTER_API_KEY is set
 *     * OPENROUTER_MODELS (comma-separated) picks specific ones
 *     * defaults to a couple of popular free-tier models
 */
export function buildDefaultPool(): LlmPool {
  const providers: LlmProviderConfig[] = [
    ollamaProvider({
      baseUrl: process.env.OLLAMA_URL,
      model: process.env.OLLAMA_MODEL,
    }),
  ];
  const orKey = process.env.OPENROUTER_API_KEY;
  if (orKey) {
    const models = (process.env.OPENROUTER_MODELS ?? "openai/gpt-oss-120b:free,minimax/minimax-m2.5:free,openai/gpt-oss-20b:free")
      .split(",").map((m) => m.trim()).filter(Boolean);
    for (const m of models) {
      providers.push(openRouterProvider({ apiKey: orKey, model: m }));
    }
  }
  return new LlmPool(providers);
}
