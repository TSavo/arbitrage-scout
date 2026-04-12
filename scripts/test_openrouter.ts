/**
 * Smoke-test OpenRouter free models with a realistic classify-like prompt.
 * Measures latency + confirms JSON output shape per model.
 */
import { readFileSync } from "node:fs";
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {}

const KEY =
  process.env.OPENROUTER_API_KEY ??
  "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";

const MODELS = [
  "openai/gpt-oss-120b:free",
  "openai/gpt-oss-20b:free",
  "google/gemma-3-12b-it:free",
  "google/gemma-3-4b-it:free",
  "nousresearch/hermes-3-llama-3.1-405b:free",
  "nvidia/nemotron-nano-9b-v2:free",
  "z-ai/glm-4.5-air:free",
  "minimax/minimax-m2.5:free",
  "qwen/qwen3-coder:free",
];

const SYSTEM = `You are classifying a product listing into a taxonomy. Reply with JSON only — no prose.`;

const PROMPT = `Listing title: "Macallan 18 Year Sherry Oak Single Malt Scotch Whisky"
Children of "scotch": single_malt_scotch, blended_malt_scotch, blended_scotch

Pick the best child. Respond with exactly:
{"type":"match","slug":"<one of the children>"}`;

async function testOne(model: string): Promise<void> {
  const t0 = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://arbitrage-scout.local",
        "X-Title": "arbitrage-scout",
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: PROMPT },
        ],
        temperature: 0,
      }),
    });
    const elapsed = Date.now() - t0;
    if (!res.ok) {
      console.log(`✗ ${model}  status=${res.status} elapsed=${elapsed}ms  ${(await res.text()).slice(0, 120)}`);
      return;
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content ?? "";
    console.log(`✓ ${model}  elapsed=${elapsed}ms  response: ${content.replace(/\s+/g, " ").slice(0, 140)}`);
  } catch (err) {
    console.log(`✗ ${model}  error: ${(err as Error).message}`);
  }
}

async function main() {
  console.log("── serial ──");
  for (const m of MODELS) await testOne(m);
  console.log("\n── parallel (all at once, should not collide) ──");
  await Promise.all(MODELS.map(testOne));
}
main().catch((e) => { console.error(e); process.exit(1); });
