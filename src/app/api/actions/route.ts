export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { runScan } from "@/scanner/scan";
import { runStock } from "@/scanner/stock";
import { detectTrends, platformTrends } from "@/scanner/trends";
import { findCrossMarketplaceDeals } from "@/scanner/arbitrage";
import { buildAdapters } from "@/sources/registry";
import { runEmbed } from "@/scanner/embed";
import { verifyOpportunityUrls } from "@/scanner/verify";

// ── Module-level state (survives across requests in the same process) ──
// NOTE: Next.js may spawn multiple workers in production. These variables are
// per-process and will NOT be shared across workers. This is acceptable for
// single-instance deployment but would need external state (e.g. Redis) for
// multi-worker setups.

const running: Record<string, boolean> = { scan: false, stock: false, embed: false };
const lastRun: Record<string, { at: string; result: unknown; error?: string } | null> = {};

export { running, lastRun };

// ── Helpers ──

function buildConfig() {
  return {
    database: { path: "data/scout-v2.db" },
    ebay: {
      app_id: process.env.EBAY_APP_ID || "",
      cert_id: process.env.EBAY_CERT_ID || "",
    },
    shopgoodwill: {
      username: process.env.SGW_USERNAME || "",
      password: process.env.SGW_PASSWORD || "",
    },
    pricecharting: {
      api_key: process.env.PC_API_KEY || "",
    },
    normalizer: {
      provider: "ollama",
      base_url: process.env.OLLAMA_URL || "http://battleaxe:11434",
      model: process.env.OLLAMA_MODEL || "qwen3:8b",
    },
    alerts: {
      min_profit_usd: 25,
      min_margin_pct: 30,
    },
  };
}

// ── POST /api/actions ──

export async function POST(request: NextRequest) {
  const body = await request.json();
  const action = body?.action as string;

  if (!action) {
    return Response.json({ error: "missing action" }, { status: 400 });
  }

  // ── Async (fire-and-forget) actions ──

  if (action === "scan") {
    if (running.scan) {
      return Response.json({ error: "scan already running" }, { status: 409 });
    }
    running.scan = true;
    const config = buildConfig();
    const adapters = buildAdapters(config);
    Promise.resolve()
      .then(() => runScan(config, adapters))
      .then((n) => {
        lastRun.scan = { at: new Date().toISOString(), result: { count: n } };
      })
      .catch((err) => {
        lastRun.scan = {
          at: new Date().toISOString(),
          result: null,
          error: String(err),
        };
      })
      .finally(() => {
        running.scan = false;
      });
    return Response.json({ status: "started" });
  }

  if (action === "stock") {
    if (running.stock) {
      return Response.json({ error: "stock already running" }, { status: 409 });
    }
    running.stock = true;
    const config = buildConfig();
    Promise.resolve()
      .then(() => runStock(config))
      .then((n) => {
        lastRun.stock = { at: new Date().toISOString(), result: { count: n } };
      })
      .catch((err) => {
        lastRun.stock = {
          at: new Date().toISOString(),
          result: null,
          error: String(err),
        };
      })
      .finally(() => {
        running.stock = false;
      });
    return Response.json({ status: "started" });
  }

  // ── Sync actions (await and return result) ──

  if (action === "trends") {
    try {
      const result = await detectTrends({
        minChangePct: 10,
        minChangeUsd: 5,
        condition: "loose",
        limit: 25,
      });
      lastRun.trends = { at: new Date().toISOString(), result };
      return Response.json({
        risersCount: result.risers.length,
        fallersCount: result.fallers.length,
        risers: result.risers,
        fallers: result.fallers,
      });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }

  if (action === "arbitrage") {
    try {
      const deals = await findCrossMarketplaceDeals({
        minProfit: 15,
        minMargin: 0.2,
      });
      lastRun.arbitrage = { at: new Date().toISOString(), result: { count: deals.length } };
      return Response.json({ dealCount: deals.length, deals });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }

  if (action === "platforms") {
    try {
      const platforms = await platformTrends();
      lastRun.platforms = { at: new Date().toISOString(), result: { count: platforms.length } };
      return Response.json({ count: platforms.length, platforms });
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }

  if (action === "verify") {
    try {
      const result = await verifyOpportunityUrls();
      lastRun.verify = { at: new Date().toISOString(), result };
      return Response.json(result);
    } catch (err) {
      return Response.json({ error: String(err) }, { status: 500 });
    }
  }

  if (action === "embed") {
    if (running.embed) {
      return Response.json({ error: "embed already running" }, { status: 409 });
    }
    running.embed = true;
    Promise.resolve()
      .then(() => runEmbed())
      .then((result) => {
        lastRun.embed = { at: new Date().toISOString(), result };
      })
      .catch((err) => {
        lastRun.embed = { at: new Date().toISOString(), result: null, error: String(err) };
      })
      .finally(() => {
        running.embed = false;
      });
    return Response.json({ status: "started" });
  }

  return Response.json({ error: `unknown action: ${action}` }, { status: 400 });
}
