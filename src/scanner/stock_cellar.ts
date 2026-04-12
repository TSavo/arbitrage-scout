/**
 * Stock-my-cellar — scrape the user's K&L order history and populate the
 * `inventory_items` table. Reuses the shared headed Chrome session (same
 * plumbing as KlwinesAdapter), so the user's logged-in cookies travel with
 * every request.
 *
 * Flow:
 *   1. Walk /Account/Receipts?p=1..N, find the Closed Order History table
 *      (columns include Shipway), collect every order ID.
 *   2. For each order id, navigate in-place to /receipt?OrderIds=X, parse
 *      line items (title, klwines_sku from the /products/details/:sku href,
 *      qty, unit price).
 *   3. Upsert inventory_items rows; resolve product_id via product_identifiers
 *      when the klwines_sku is already known, otherwise leave null for a
 *      future scan to link.
 *   4. Auto-create watchlist_items for alert-on-appreciation.
 */

import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import {
  inventoryItems,
  watchlistItems,
  productIdentifiers,
  products,
} from "@/db/schema";
import { getSharedContext } from "@/lib/shared_browser";
import { log, section, skip } from "@/lib/logger";
import type { Page } from "playwright";

const BASE = "https://www.klwines.com";
const MAX_PAGES = 20; // safety cap
const ALERT_PCT = 0.20; // watchlist alert when current >= purchase * (1 + 0.20)
/** Bursty human-ish pacing: most requests 5–12s apart, occasional longer
 *  dwells, matching the bot-cadence preference the rest of the scrapers
 *  use. This is a one-time import, no reason to hammer. */
function humanPause(): number {
  const r = Math.random();
  if (r < 0.1) return 20_000 + Math.random() * 40_000;
  return 5_000 + Math.random() * 7_000;
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface OrderMeta {
  readonly id: string;
  readonly date: string;
  readonly status: string;
  readonly shipway: string;
  readonly tracking: string;
}

interface ReceiptLine {
  readonly title: string;
  readonly sku: string | null;
  readonly qty: number;
  readonly unitPriceUsd: number | null;
}

/** Scrape every order the user has — Closed History (paginated, Shipway
 *  column) AND Open Orders (in-storage / pending pickup). We no longer
 *  pre-filter by shipway; the receipt content tells us what's a real
 *  purchase and what's a delivery consolidation. */
async function fetchAllOrders(page: Page): Promise<OrderMeta[]> {
  const all: OrderMeta[] = [];
  const seenIds = new Set<string>();

  // Open Orders (no pagination — one table, all rows).
  await page.goto(`${BASE}/Account/Receipts`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const openRows: OrderMeta[] = await page.evaluate(`(() => {
    const tables = Array.from(document.querySelectorAll('table'));
    // Open Orders table has 'Total' in the header and no 'Shipway'.
    const t = tables.find(t => {
      const headers = Array.from(t.querySelectorAll('thead th, tr:first-child th')).map(c => c.textContent?.trim() || '');
      return headers.some(h => /Total/i.test(h)) && !headers.some(h => /Shipway/i.test(h));
    });
    if (!t) return [];
    return Array.from(t.querySelectorAll('tbody tr')).map(tr => {
      const cells = Array.from(tr.querySelectorAll('td')).map(c => (c.textContent || '').replace(/\\s+/g, ' ').trim());
      return { id: cells[0] || '', date: cells[1] || '', status: cells[3] || '', shipway: 'open', tracking: '' };
    }).filter(r => /^\\d+$/.test(r.id));
  })()`);
  for (const r of openRows) if (!seenIds.has(r.id)) { seenIds.add(r.id); all.push(r); }
  log("cellar", `open orders: ${openRows.length} rows`);

  // Closed History — paginated.
  for (let p = 1; p <= MAX_PAGES; p++) {
    const url = `${BASE}/Account/Receipts?p=${p}`;
    if (p > 1) await sleep(humanPause());
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    const rows: OrderMeta[] = await page.evaluate(`(() => {
      const tables = Array.from(document.querySelectorAll('table'));
      const t = tables.find(t => {
        const headers = Array.from(t.querySelectorAll('thead th, tr:first-child th')).map(c => c.textContent?.trim() || '');
        return headers.some(h => /Shipway/i.test(h));
      });
      if (!t) return [];
      return Array.from(t.querySelectorAll('tbody tr')).map(tr => {
        const cells = Array.from(tr.querySelectorAll('td')).map(c => (c.textContent || '').replace(/\\s+/g, ' ').trim());
        return { id: cells[0] || '', date: cells[1] || '', status: cells[2] || '', shipway: cells[3] || '', tracking: cells[4] || '' };
      }).filter(r => /^\\d+$/.test(r.id));
    })()`);
    if (rows.length === 0) {
      log("cellar", `closed page ${p}: empty — stopping`);
      break;
    }
    const newRows = rows.filter((r) => !seenIds.has(r.id));
    for (const r of newRows) seenIds.add(r.id);
    log("cellar", `closed page ${p}: ${rows.length} rows (${newRows.length} new)`);
    if (newRows.length === 0) break; // pagination wrap
    all.push(...newRows);
  }
  return all;
}

async function fetchReceiptLines(page: Page, orderId: string): Promise<ReceiptLine[]> {
  const url = `${BASE}/receipt?OrderIds=${orderId}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return page.evaluate(`(() => {
    // Every line item is anchored by an /products/details/:sku link; the
    // surrounding block has Unit Price + qty. Walk those anchors.
    const anchors = Array.from(document.querySelectorAll('a[href*="/products/details/"]'));
    const seenHrefs = new Set();
    const lines = [];
    for (const a of anchors) {
      const href = a.getAttribute('href') || '';
      if (seenHrefs.has(href)) continue;
      seenHrefs.add(href);
      const m = href.match(/\\/products\\/details\\/(\\d+)/);
      const sku = m ? m[1] : null;
      const title = (a.textContent || '').replace(/\\s+/g, ' ').trim();
      if (!title || title.length < 5) continue;
      // Walk up to find the nearest block with Unit Price / qty.
      let node = a.parentElement;
      let block = '';
      while (node && block.length < 10) {
        const text = (node.innerText || '').replace(/\\s+/g, ' ');
        if (/Unit Price/i.test(text) && /(qty|quantity)/i.test(text)) {
          block = text;
          break;
        }
        node = node.parentElement;
      }
      const qty = parseInt(block.match(/(?:qty|quantity)[:\\s]*(\\d+)/i)?.[1] || '1', 10);
      const unit = parseFloat(block.match(/Unit Price[:\\s]*\\$?([\\d,.]+)/i)?.[1]?.replace(/,/g,'') || '');
      lines.push({
        title,
        sku,
        qty: Number.isFinite(qty) ? qty : 1,
        unitPriceUsd: Number.isFinite(unit) ? unit : null,
      });
    }
    return lines;
  })()`);
}

function parseOrderDate(raw: string): string | null {
  // "Dec 6, 2024" → "2024-12-06"
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

async function resolveProductId(sku: string): Promise<string | null> {
  if (!sku) return null;
  const hit = await db.query.productIdentifiers.findFirst({
    where: and(
      eq(productIdentifiers.identifierType, "klwines_sku"),
      eq(productIdentifiers.identifierValue, sku),
    ),
    columns: { productId: true },
  });
  return hit?.productId ?? null;
}

async function upsertInventoryRow(row: {
  productId: string | null;
  sourceSku: string | null;
  sourceOrderId: string;
  title: string;
  quantity: number;
  purchasePriceUsd: number | null;
  purchaseDate: string | null;
}): Promise<{ inserted: boolean }> {
  const now = new Date().toISOString();
  const existing = await db.query.inventoryItems.findFirst({
    where: and(
      eq(inventoryItems.source, "klwines"),
      eq(inventoryItems.sourceOrderId, row.sourceOrderId),
      row.sourceSku
        ? eq(inventoryItems.sourceSku, row.sourceSku)
        : eq(inventoryItems.sourceSku, ""),
    ),
    columns: { id: true, productId: true },
  });
  if (existing) {
    // Backfill productId if we now have one and the row didn't.
    if (!existing.productId && row.productId) {
      await db
        .update(inventoryItems)
        .set({ productId: row.productId })
        .where(eq(inventoryItems.id, existing.id));
    }
    return { inserted: false };
  }
  await db.insert(inventoryItems).values({
    productId: row.productId,
    source: "klwines",
    sourceSku: row.sourceSku,
    sourceOrderId: row.sourceOrderId,
    title: row.title,
    quantity: row.quantity,
    purchasePriceUsd: row.purchasePriceUsd,
    purchaseDate: row.purchaseDate,
    importedAt: now,
  });
  return { inserted: true };
}

async function ensureWatchlistEntry(
  productId: string,
  alertPct: number,
): Promise<boolean> {
  const now = new Date().toISOString();
  const existing = await db.query.watchlistItems.findFirst({
    where: and(
      eq(watchlistItems.productId, productId),
      eq(watchlistItems.active, true),
    ),
    columns: { id: true },
  });
  if (existing) return false;
  await db.insert(watchlistItems).values({
    productId,
    targetPricePct: alertPct * 100, // field stored as percent, e.g. 20
    condition: "loose",
    createdAt: now,
    active: true,
    notes: "auto-added from K&L cellar import",
  });
  return true;
}

export async function stockCellar(): Promise<{
  orders: number;
  items: number;
  linked: number;
  watched: number;
}> {
  section("STOCK CELLAR — scraping K&L order history");

  const ctx = await getSharedContext();
  const page =
    ctx.pages().find((p) => /klwines\.com/.test(p.url())) ??
    (await ctx.newPage());
  try {
    await page.bringToFront().catch(() => {});

    const orders = await fetchAllOrders(page);
    log("cellar", `found ${orders.length} total orders (open + closed)`);
    if (orders.length === 0) {
      skip("cellar", "no closed orders — ensure you're logged in");
      return { orders: 0, items: 0, linked: 0, watched: 0 };
    }

    let itemsInserted = 0;
    let linked = 0;
    let watched = 0;
    let skippedPlaceholder = 0;
    for (const [i, order] of orders.entries()) {
      log("cellar", `order ${i + 1}/${orders.length}: #${order.id} (${order.date}) shipway="${order.shipway}"`);
      // Space requests out — we're in no hurry, and this is a logged-in
      // session we absolutely don't want to poke K&L's rate limiters with.
      if (i > 0) await sleep(humanPause());
      const rawLines = await fetchReceiptLines(page, order.id);
      // Filter out delivery-consolidation placeholders: $0 lines, or titles
      // that K&L uses for "previously purchased" bookkeeping rows. These
      // appear in RareStorage - Delivery receipts and aren't real purchases.
      const lines = rawLines.filter((l) => {
        const placeholder =
          (l.unitPriceUsd === 0 || l.unitPriceUsd === null) &&
          /Previously Purchased|Shipping Calculator/i.test(l.title);
        if (placeholder) skippedPlaceholder++;
        return !placeholder;
      });
      log("cellar", `  → ${rawLines.length} line(s), ${lines.length} real`);
      const purchaseDate = parseOrderDate(order.date);
      for (const line of lines) {
        const productId = line.sku ? await resolveProductId(line.sku) : null;
        const { inserted } = await upsertInventoryRow({
          productId,
          sourceSku: line.sku,
          sourceOrderId: order.id,
          title: line.title,
          quantity: line.qty,
          purchasePriceUsd: line.unitPriceUsd,
          purchaseDate,
        });
        if (inserted) itemsInserted++;
        if (productId) {
          linked++;
          if (await ensureWatchlistEntry(productId, ALERT_PCT)) watched++;
        }
      }
    }

    // Return tab to the orders page for the user.
    await page
      .goto(`${BASE}/Account/Receipts`, { waitUntil: "domcontentloaded", timeout: 20_000 })
      .catch(() => {});

    section("STOCK CELLAR COMPLETE");
    log(
      "cellar",
      `orders=${orders.length} items=${itemsInserted} (skipped ${skippedPlaceholder} placeholder) linked=${linked} watched=${watched}`,
    );
    return { orders: orders.length, items: itemsInserted, linked, watched };
  } finally {
    // Never close the page — user's session stays intact.
  }
}
