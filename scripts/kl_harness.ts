/**
 * K&L harness — fully isolates what's happening.
 * Reports:
 *   - which Chrome process is behind the CDP endpoint
 *   - all existing contexts & their pages
 *   - a fresh navigation to klwines with all responses logged
 *   - current klwines cookies (auth survived?)
 *   - whether a logged-in pathway works (/Account vs /)
 *   - a direct curl with the Chrome user-agent (rules out Playwright-specific flags)
 */
import { chromium } from "playwright";
import { execSync } from "node:child_process";

async function main() {
  console.log("── CDP endpoint info ──");
  try {
    const ver = execSync('curl -s -m 3 http://127.0.0.1:9222/json/version', { encoding: "utf8" });
    console.log(ver.trim());
  } catch (err) {
    console.log(`CDP unreachable: ${(err as Error).message}`);
    return;
  }

  const browser = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const ctxs = browser.contexts();
  console.log(`\n── Contexts: ${ctxs.length}`);
  for (let i = 0; i < ctxs.length; i++) {
    const pages = ctxs[i].pages();
    console.log(`  context[${i}]  pages=${pages.length}`);
    for (const p of pages) {
      console.log(`    ${p.url().slice(0, 100)}`);
    }
  }

  const ctx = ctxs[0];
  if (!ctx) { console.log("no context"); return; }

  // Inspect cookies
  const cookies = await ctx.cookies("https://www.klwines.com");
  console.log(`\n── klwines cookies: ${cookies.length}`);
  const authish = cookies.filter((c) => /auth|session|sso|token|login|algolia_user/i.test(c.name));
  for (const c of authish.slice(0, 5)) {
    console.log(`  ${c.name} (expires ${c.expires > 0 ? new Date(c.expires * 1000).toISOString() : "session"})`);
  }

  // Fresh page
  console.log(`\n── Fresh goto https://www.klwines.com/ ──`);
  const page = await ctx.newPage();
  const responses: Array<{ url: string; status: number }> = [];
  page.on("response", (r) => {
    const u = r.url();
    if (u.includes("klwines") && !u.match(/\.(js|css|png|svg|woff2?|jpg|ico)(\?|$)/)) {
      responses.push({ url: u, status: r.status() });
    }
  });
  try {
    const resp = await page.goto("https://www.klwines.com/", { waitUntil: "domcontentloaded", timeout: 20_000 });
    console.log(`  main goto: status=${resp?.status()} url=${resp?.url().slice(0, 100)}`);
    console.log(`  title: "${await page.title()}"`);
    const bodyLen = (await page.evaluate(() => document.body?.innerText?.length ?? 0));
    console.log(`  body length: ${bodyLen}`);
  } catch (err) {
    console.log(`  FAIL: ${(err as Error).message}`);
  }
  console.log(`  network responses (non-static):`);
  for (const r of responses.slice(0, 15)) {
    console.log(`    [${r.status}] ${r.url.slice(0, 110)}`);
  }

  // Account page — tests auth
  console.log(`\n── /Account (logged-in check) ──`);
  try {
    const resp = await page.goto("https://www.klwines.com/Account", { waitUntil: "domcontentloaded", timeout: 20_000 });
    console.log(`  status=${resp?.status()} url=${page.url().slice(0, 100)} title="${await page.title()}"`);
    const signOut = await page.evaluate(() =>
      !!Array.from(document.querySelectorAll("a,button")).find((e) => /sign\s*out|log\s*out/i.test(e.textContent || ""))
    );
    console.log(`  logged in: ${signOut}`);
  } catch (err) {
    console.log(`  FAIL: ${(err as Error).message}`);
  }

  // Curl with Chrome UA — rules out Playwright-specific header fingerprint
  console.log(`\n── curl with Chrome UA ──`);
  try {
    const out = execSync(
      `curl -s -o /dev/null -w "status=%{http_code} time=%{time_total}s size=%{size_download}\\n" -m 10 ` +
      `-A "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36" ` +
      `https://www.klwines.com/`,
      { encoding: "utf8" }
    );
    console.log(`  ${out.trim()}`);
  } catch (err) {
    console.log(`  FAIL: ${(err as Error).message}`);
  }

  await page.close();
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
