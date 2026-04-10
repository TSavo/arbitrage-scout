/**
 * Ollama HTTP client for the normalizer.
 *
 * Wraps fetch to talk to Ollama's /api/generate endpoint.
 * Caches LLM responses with a long TTL because temperature=0 outputs
 * are deterministic — identical (model, prompt, system) tuples should never
 * cost a second call.
 *
 * Defaults match the arbitrage-scout setup on battleaxe (qwen3:8b, think=False
 * to skip the chain-of-thought trace).
 */

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { log, error } from "@/lib/logger";

export const DEFAULT_BASE_URL = "http://battleaxe:11434";
export const DEFAULT_MODEL = "qwen3:8b";
const LLM_CACHE_TTL_SECONDS = 365 * 24 * 3600; // 1 year — deterministic at temp=0

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
  cacheDir?: string;
}

export class OllamaClient {
  private baseUrl: string;
  private model: string;
  private think: boolean;
  private temperature: number;
  private cacheDir: string | null;

  constructor(opts: OllamaClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.model = opts.model ?? DEFAULT_MODEL;
    this.think = opts.think ?? false;
    this.temperature = opts.temperature ?? 0.0;
    this.cacheDir = opts.cacheDir ?? null;
  }

  private cacheKey(model: string, prompt: string, system?: string): string {
    const h = crypto.createHash("sha256");
    h.update(JSON.stringify({ model, prompt, system: system ?? "" }));
    return h.digest("hex");
  }

  private readCache(key: string): string | null {
    if (!this.cacheDir) return null;
    const p = path.join(this.cacheDir, "llm", `${key}.json`);
    try {
      const raw = fs.readFileSync(p, "utf8");
      const { ts, value } = JSON.parse(raw) as { ts: number; value: string };
      if (Date.now() / 1000 - ts < LLM_CACHE_TTL_SECONDS) return value;
    } catch {
      // miss or corrupt
    }
    return null;
  }

  private writeCache(key: string, value: string): void {
    if (!this.cacheDir) return;
    const dir = path.join(this.cacheDir, "llm");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${key}.json`),
      JSON.stringify({ ts: Math.floor(Date.now() / 1000), value }),
    );
  }

  async generate(
    prompt: string,
    opts: { system?: string; model?: string } = {},
  ): Promise<string> {
    const model = opts.model ?? this.model;
    const key = this.cacheKey(model, prompt, opts.system);
    const cached = this.readCache(key);
    if (cached !== null) {
      log("ollama", `cache HIT model=${model} promptLen=${prompt.length} responseLen=${cached.length}`);
      return cached;
    }

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

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      error("ollama", `generate failed: HTTP ${res.status} (${Date.now() - t0}ms)`);
      throw new OllamaError(`Ollama HTTP ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { response?: string };
    const text = data.response;
    if (typeof text !== "string") {
      error("ollama", `unexpected response shape after ${Date.now() - t0}ms`);
      throw new OllamaError(`Unexpected response shape: ${JSON.stringify(data)}`);
    }

    log("ollama", `generate OK responseLen=${text.length} elapsed=${Date.now() - t0}ms (writing cache)`);
    this.writeCache(key, text);
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
