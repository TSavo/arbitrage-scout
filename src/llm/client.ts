/**
 * Ollama HTTP client.
 *
 * Wraps /api/generate for text/JSON generation and /api/embed for embeddings.
 * Temperature is fixed at 0 — outputs are deterministic, suitable for caching
 * at the call-site if desired.
 *
 * Config via env:
 *   OLLAMA_URL   — default http://battleaxe:11434
 *   OLLAMA_MODEL — default qwen3:8b
 */

import { log, error } from "@/lib/logger";

const DEFAULT_URL = process.env.OLLAMA_URL ?? "http://battleaxe:11434";
const DEFAULT_MODEL = process.env.OLLAMA_MODEL ?? "qwen3:8b";
const EMBED_MODEL = "qwen3-embedding:8b";

// ── Error type ────────────────────────────────────────────────────────

export class OllamaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OllamaError";
  }
}

// ── JSON extraction helpers ───────────────────────────────────────────

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

// ── Client ────────────────────────────────────────────────────────────

interface GenerateOptions {
  system?: string;
  model?: string;
}

/**
 * Call /api/generate and return the raw response text.
 */
export async function generate(
  prompt: string,
  opts: GenerateOptions = {},
): Promise<string> {
  const baseUrl = DEFAULT_URL.replace(/\/$/, "");
  const model = opts.model ?? DEFAULT_MODEL;
  const body: Record<string, unknown> = {
    model,
    prompt,
    stream: false,
    think: false,
    options: { temperature: 0 },
  };
  if (opts.system) body.system = opts.system;

  const t0 = Date.now();
  log("llm/client", `generate model=${model} promptLen=${prompt.length} url=${baseUrl}`);

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    error("llm/client", `generate failed: ${res.status} ${res.statusText} (${Date.now() - t0}ms)`);
    throw new OllamaError(`Ollama generate failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as Record<string, unknown>;
  const text = data["response"];
  if (typeof text !== "string") {
    error("llm/client", `unexpected response shape after ${Date.now() - t0}ms`);
    throw new OllamaError(`Unexpected Ollama response shape: ${JSON.stringify(data)}`);
  }
  log("llm/client", `generate OK responseLen=${text.length} elapsed=${Date.now() - t0}ms`);
  return text;
}

/**
 * Generate and parse the response as JSON.
 * Tolerates ```json fences and leading/trailing prose.
 */
export async function generateJson(
  prompt: string,
  system?: string,
): Promise<unknown> {
  const text = await generate(prompt, { system });
  try {
    return parseJsonBlob(text);
  } catch (err) {
    throw new OllamaError(
      `Could not parse JSON from LLM output: ${text.slice(0, 200)}`,
    );
  }
}

/**
 * Embed a single string using qwen3-embedding:8b.
 * Returns a float vector.
 */
export async function embed(text: string): Promise<number[]> {
  const baseUrl = DEFAULT_URL.replace(/\/$/, "");

  const t0 = Date.now();
  log("llm/client", `embed model=${EMBED_MODEL} inputLen=${text.length}`);

  const res = await fetch(`${baseUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });

  if (!res.ok) {
    error("llm/client", `embed failed: ${res.status} ${res.statusText} (${Date.now() - t0}ms)`);
    throw new OllamaError(`Ollama embed failed: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as { embeddings?: number[][] };
  const vec = data.embeddings?.[0];
  if (!vec) {
    error("llm/client", `embed returned no vector after ${Date.now() - t0}ms`);
    throw new OllamaError(`Ollama embed returned no embeddings for input: ${text.slice(0, 80)}`);
  }
  log("llm/client", `embed OK dim=${vec.length} elapsed=${Date.now() - t0}ms`);
  return vec;
}
