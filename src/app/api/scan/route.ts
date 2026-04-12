export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { runScan } from "@/scanner/scan";
import { buildAdapters } from "@/sources/registry";
import { log } from "@/lib/logger";

let scanRunning = false;

function buildConfig() {
  return {
    database: { path: process.env.DB_PATH || "data/scout-v2.db" },
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
    klwines: {
      userDataDir: process.env.KLWINES_USER_DATA_DIR,
      cdpPort: process.env.KLWINES_CDP_PORT
        ? parseInt(process.env.KLWINES_CDP_PORT, 10)
        : undefined,
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

export async function POST(_request: NextRequest) {
  if (scanRunning) {
    return Response.json({ error: "Scan already running" }, { status: 409 });
  }

  scanRunning = true;
  const config = buildConfig();
  const adapters = buildAdapters(config);

  runScan(config, adapters)
    .then((n) => {
      log("api/scan", `scan finished: ${n} opportunities`);
    })
    .catch((err) => {
      log("api/scan", `scan failed: ${err}`);
    })
    .finally(() => {
      scanRunning = false;
    });

  return Response.json({ status: "started", action: "scan" });
}
