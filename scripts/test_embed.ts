/** Direct test of the embedding endpoint to isolate whether it's slow/stalled. */
export {};
const OLLAMA = process.env.OLLAMA_URL ?? "http://battleaxe:11434";

async function timeOne(text: string, n: number) {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error("timeout")), 30_000);
  try {
    const res = await fetch(`${OLLAMA}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "qwen3-embedding:8b", input: text }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const elapsed = Date.now() - t0;
    if (!res.ok) { console.log(`#${n}  status=${res.status} elapsed=${elapsed}ms`); return; }
    const data = (await res.json()) as { embeddings?: number[][] };
    const dim = data.embeddings?.[0]?.length ?? 0;
    console.log(`#${n}  OK dim=${dim} elapsed=${elapsed}ms`);
  } catch (e) {
    clearTimeout(timer);
    console.log(`#${n}  FAIL after ${Date.now() - t0}ms: ${(e as Error).message}`);
  }
}

async function main() {
  console.log(`Target: ${OLLAMA}`);
  const texts = [
    "2023 Istine Chianti Classico",
    "Macallan 18 Year Sherry Oak Single Malt Scotch Whisky",
    "Pappy Van Winkle 23 Year Family Reserve",
    "Foursquare Exceptional Cask Mark XII Barbados Rum",
    "2002 Plantation 15 Year Old Barbados Rum",
  ];
  // Serial
  console.log("\n── serial x5 ──");
  for (let i = 0; i < texts.length; i++) await timeOne(texts[i], i + 1);
  // Parallel
  console.log("\n── parallel x5 ──");
  await Promise.all(texts.map((t, i) => timeOne(t, i + 1)));
}
main();
