import { chromium } from "playwright";
async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctx = b.contexts()[0]!;
  const page = await ctx.newPage();
  page.on("response", (r) => {
    const url = r.url();
    if (url.includes("klwines") && !url.includes(".js") && !url.includes(".css") && !url.includes(".png") && !url.includes(".svg") && !url.includes(".woff"))
      console.log(`  [resp] ${r.status()} ${url.slice(0, 120)}`);
  });
  try {
    const resp = await page.goto("https://www.klwines.com/", { waitUntil: "domcontentloaded", timeout: 20000 });
    console.log(`main status: ${resp?.status()} title: "${await page.title()}"`);
    const text = (await page.evaluate(() => document.body?.innerText ?? "")).slice(0, 400);
    console.log(`body preview: "${text}"`);
  } catch (err) {
    console.log(`FAIL: ${(err as Error).message}`);
  }
  await page.close();
  await b.close();
}
main();
