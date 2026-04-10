export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { db } from "@/db/client";
import { scanLogs } from "@/db/schema";

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const type = body?.type ?? "scan";

  // Insert a scan log entry to record the trigger
  const now = new Date().toISOString();
  const result = db
    .insert(scanLogs)
    .values({
      startedAt: now,
      queriesRun: 0,
      listingsFound: 0,
      opportunitiesFound: 0,
      rateLimited: false,
    })
    .run();

  return Response.json({
    status: "started",
    type,
    scanLogId: result.lastInsertRowid,
    startedAt: now,
  });
}
