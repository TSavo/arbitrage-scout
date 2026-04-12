/**
 * cachedFetch — drop-in fetch replacement backed by the durable http_cache table.
 *
 * Every outbound API call flows through here. LLM calls, embedding calls, eBay
 * search, PriceCharting CSVs, metadata lookups — all of them. If we've seen
 * the exact request (method + url + body) within its TTL, we return the cached
 * response and never touch the network.
 *
 * TTL is per-call-site. Caller picks. Defaults:
 *   - null / undefined → infinite (never expires)
 *   - 0               → bypass cache entirely (force network)
 *   - >0              → expire after that many ms
 *
 * Only 2xx responses are cached. Failures pass through so the caller sees the
 * actual error and can retry.
 */

import { httpCacheRepo } from "@/db/repos/HttpCacheRepo";
import { log } from "@/lib/logger";


export interface CachedFetchOptions {
  /** null/undefined = infinite, 0 = bypass, >0 = TTL in ms. */
  readonly ttlMs?: number | null;
  /** Label for logging/metrics. */
  readonly cacheTag?: string;
  /** Hard timeout on each attempt (ms). Default 60s. */
  readonly networkTimeoutMs?: number;
  /** Total retry attempts on transient failure. Default 3. 4xx never retries. */
  readonly maxRetries?: number;
  /**
   * Serialize all calls sharing this key through a single-slot queue. Use
   * for GPU-backed services (Ollama) where parallel LLM + embedding calls
   * thrash model-swap. Pass e.g. `"ollama"` at every call site that hits
   * the same Ollama instance; they'll run strictly one-at-a-time.
   */
  readonly serializeKey?: string;
}

// ── per-key mutex registry ──────────────────────────────────────────────
//
// When a caller passes `serializeKey`, every call sharing that key runs
// strictly serially. Implemented as a promise chain per key: new calls
// attach to the tail of the chain and wait their turn. Cache hits bypass
// serialization — only real network calls need the lock.

const mutexChains = new Map<string, Promise<void>>();

/** Minimum wall-clock gap between consecutive calls for a given mutex key.
 *  Enforces host-side rate limits by holding the lock past fn completion. */
const MIN_GAP_MS: Record<string, number> = {
  discogs: 1100, // 1 req/sec documented limit + 100ms buffer
  // Free-tier OpenRouter caps at 16 req/min (observed via X-RateLimit-Limit),
  // not the nominal 20. 4.5s gap = 13.3/min, safely under.
  openrouter: 4500,
  // Shopify-backed retailers have no published rate limit but start
  // throwing 429s when all 7 adapters hit products.json in parallel. 350ms
  // gap = ~170/min per host, well below the threshold we saw trigger 429s.
  "shopify:bittersandbottles": 350,
  "shopify:seelbachs": 350,
  "shopify:shopsk": 350,
  "shopify:woodencork": 350,
  "shopify:caskcartel": 350,
  "shopify:whiskybusiness": 350,
  "shopify:flaviar": 350,
};

async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = mutexChains.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => { release = resolve; });
  mutexChains.set(key, prev.then(() => next));
  const minGap = MIN_GAP_MS[key] ?? 0;
  const t0 = Date.now();
  try {
    await prev;
    return await fn();
  } finally {
    // Hold the lock for at least minGap total so the NEXT caller waits
    // until the rate-limit window elapses.
    const elapsed = Date.now() - t0;
    const wait = minGap - elapsed;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    release();
    if (mutexChains.get(key) === prev.then(() => next)) {
      mutexChains.delete(key);
    }
  }
}

export interface CachedResponse {
  readonly ok: boolean;
  readonly status: number;
  readonly body: string;
  readonly fromCache: boolean;
  json<T = unknown>(): T;
  text(): string;
}

function makeResponse(
  status: number,
  body: string,
  fromCache: boolean,
): CachedResponse {
  return Object.freeze({
    ok: status >= 200 && status < 300,
    status,
    body,
    fromCache,
    json<T = unknown>(): T {
      return JSON.parse(body) as T;
    },
    text(): string {
      return body;
    },
  });
}

let hits = 0;
let misses = 0;

export function cacheMetrics(): { readonly hits: number; readonly misses: number } {
  return { hits, misses };
}

export async function cachedFetch(
  url: string,
  init: RequestInit = {},
  opts: CachedFetchOptions = {},
): Promise<CachedResponse> {
  const method = (init.method ?? "GET").toUpperCase();
  const body =
    typeof init.body === "string"
      ? init.body
      : init.body == null
        ? null
        : JSON.stringify(init.body);

  const bypass = opts.ttlMs === 0;

  if (!bypass) {
    const cached = await httpCacheRepo.lookup({ method, url, body });
    if (cached) {
      hits++;
      if (opts.cacheTag) {
        log("http-cache", `HIT ${opts.cacheTag} ${method} ${shortUrl(url)}`);
      }
      return makeResponse(cached.status, cached.body, true);
    }
  }

  misses++;

  const timeoutMs = opts.networkTimeoutMs ?? 60_000;
  const maxRetries = Math.max(1, opts.maxRetries ?? 3);
  const tag = opts.cacheTag ?? "fetch";

  // Auto-serialize calls to hosts that need single-flight treatment:
  //   - Ollama: GPU model-swap thrash if LLM + embed run concurrently
  //   - Discogs API: enforced 1 req/sec rate limit, 429s with retry spam
  // Callers can override with an explicit serializeKey.
  const autoKey = autoSerializeKey(url);
  const serializeKey = opts.serializeKey ?? autoKey;

  if (serializeKey) {
    return withMutex(serializeKey, () =>
      doFetch(url, init, method, body, timeoutMs, maxRetries, tag, bypass, opts),
    );
  }
  return doFetch(url, init, method, body, timeoutMs, maxRetries, tag, bypass, opts);
}

function autoSerializeKey(url: string): string | undefined {
  // Ollama: any /api/<op> path on the local Ollama host. GPU serialization
  // prevents model-swap thrash between LLM generate + embedding calls.
  // NOTE: OpenRouter is also on a /v1/chat/completions path, so match the
  // Ollama-specific set only.
  if (/\/api\/(generate|embed|chat|tokenize|show)\b/.test(url) &&
      !/openrouter\.ai/.test(url)) return "ollama";
  // Discogs: hard 1 req/sec rate limit.
  if (/\/\/(api\.)?discogs\.com\//i.test(url)) return "discogs";
  return undefined;
}

async function doFetch(
  url: string,
  init: RequestInit,
  method: string,
  body: string | null,
  timeoutMs: number,
  maxRetries: number,
  tag: string,
  bypass: boolean,
  opts: CachedFetchOptions,
): Promise<CachedResponse> {

  // Retry loop — exponential backoff on transient failures (abort/timeout,
  // network error, 5xx). 4xx is a real error and never retries.
  let attempt = 0;
  let resp: Response | null = null;
  let text: string = "";
  let contentType: string | null = null;
  let lastErr: unknown = null;

  while (attempt < maxRetries) {
    attempt++;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error(`cachedFetch timeout after ${timeoutMs}ms`)),
      timeoutMs,
    );
    const attemptStart = Date.now();
    try {
      resp = await fetch(url, { ...init, signal: controller.signal });
      text = await resp.text();
      contentType = resp.headers.get("content-type");
      clearTimeout(timer);

      // Retryable server errors: 5xx, 408 (Request Timeout), 429 (Too Many).
      if (resp.status >= 500 || resp.status === 408 || resp.status === 429) {
        if (attempt < maxRetries) {
          const backoff = 500 * Math.pow(2, attempt - 1);
          log(
            "http-cache",
            `RETRY ${tag} ${method} ${shortUrl(url)} status=${resp.status} attempt=${attempt}/${maxRetries} backoff=${backoff}ms`,
          );
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
      }
      break;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      const elapsed = Date.now() - attemptStart;
      if (attempt < maxRetries) {
        const backoff = 500 * Math.pow(2, attempt - 1);
        log(
          "http-cache",
          `RETRY ${tag} ${method} ${shortUrl(url)} attempt=${attempt}/${maxRetries} error="${(err as Error).message}" after ${elapsed}ms backoff=${backoff}ms`,
        );
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }
      throw err;
    }
  }

  if (!resp) {
    throw lastErr instanceof Error ? lastErr : new Error(`cachedFetch: no response after ${maxRetries} attempts`);
  }

  if (resp.ok && !bypass) {
    await httpCacheRepo.store({
      method,
      url,
      body,
      status: resp.status,
      responseBody: text,
      contentType,
      ttlMs: opts.ttlMs,
    });
    if (opts.cacheTag) {
      log("http-cache", `MISS ${opts.cacheTag} ${method} ${shortUrl(url)} (stored)`);
    }
  } else if (opts.cacheTag) {
    log("http-cache", `MISS ${opts.cacheTag} ${method} ${shortUrl(url)} status=${resp.status}`);
  }

  return makeResponse(resp.status, text, false);
}

function shortUrl(url: string): string {
  return url.length > 80 ? url.slice(0, 77) + "..." : url;
}
