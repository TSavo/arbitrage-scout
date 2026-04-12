/**
 * Ollama HTTP client for the normalizer.
 *
 * Every call flows through cachedFetch. At temperature=0 the (model, prompt,
 * system) tuple is deterministic — identical requests are served from the
 * durable http_cache table and never hit the network. TTL is infinite.
 *
 * Defaults match the arbitrage-scout setup on battleaxe (qwen3:8b, think=False
 * to skip the chain-of-thought trace).
 */

import { cachedFetch } from "@/lib/cached_fetch";
import { log, error } from "@/lib/logger";

export const DEFAULT_BASE_URL = "http://battleaxe:11434";
export const DEFAULT_MODEL = "qwen3:8b";

const FENCE_RE = /```(?:json)?\s*([\s\S]+?)\s*```/i;
const OBJECT_RE = /(\{[\s\S]*\}|\[[\s\S]*\])/;

export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaError";
  }
}

function parseJsonBlob(text: string): unknown {
  text = text.trim();
  const fenceMatch = FENCE_RE.exec(text);
  if (fenceMatch) return JSON.parse(fenceMatch[1].trim());
  const objMatch = OBJECT_RE.exec(text);
  if (objMatch) return JSON.parse(objMatch[1]);
  return JSON.parse(text);
}

interface OllamaClientOptions {
  baseUrl?: string;
  model?: string;
  think?: boolean;
  temperature?: number;
}

export class OllamaClient {
  private baseUrl: string;
  private model: string;
  private think: boolean;
  private temperature: number;

  constructor(opts: OllamaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.think = opts.think ?? false;
    this.temperature = opts.temperature ?? 0.0;
  }

  async generate(
    prompt: string,
    opts: { system?: string; model?: string } = {},
  ): Promise<string> {
    const model = opts.model ?? this.model;
    log("ollama", `generate model=${model} promptLen=${prompt.length} url=${this.baseUrl}`);
    const t0 = Date.now();

    const body: Record<string, unknown> = {
      model,
      prompt,
      stream: false,
      think: this.think,
      options: { temperature: this.temperature },
    };
    if (opts.system !== undefined) body["system"] = opts.system;

    const res = await cachedFetch(
      `${this.baseUrl}/api/generate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      { ttlMs: null, cacheTag: "llm" },
    );

    if (!res.ok) {
      error("ollama", `generate failed: HTTP ${res.status} (${Date.now() - t0}ms)`);
      throw new OllamaError(`Ollama HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    }

    const data = res.json<{ response?: string }>();
    const text = data.response;
    if (typeof text !== "string") {
      error("ollama", `unexpected response shape after ${Date.now() - t0}ms`);
      throw new OllamaError(`Unexpected response shape: ${JSON.stringify(data)}`);
    }

    log(
      "ollama",
      `generate OK responseLen=${text.length} elapsed=${Date.now() - t0}ms fromCache=${res.fromCache}`,
    );
    return text;
  }

  async generateJson(
    prompt: string,
    opts: { system?: string; model?: string } = {},
  ): Promise<unknown> {
    const text = await this.generate(prompt, opts);
    try {
      return parseJsonBlob(text);
    } catch {
      throw new OllamaError(`Could not parse JSON from LLM output: ${text.slice(0, 200)}`);
    }
  }
}
