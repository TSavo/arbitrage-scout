export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { db } from "@/db/client";
import { opportunities } from "@/db/schema";
import { eq } from "drizzle-orm";

const VALID_STATUSES = ["new", "reviewed", "purchased", "passed"];

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/opportunities/[id]">
) {
  const { id } = await ctx.params;
  const numericId = parseInt(id, 10);

  if (isNaN(numericId)) {
    return Response.json({ error: "Invalid ID" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const { status, notes } = body;

  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return Response.json(
      { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  const updates: Partial<{
    status: string;
    notes: string;
    reviewedAt: string;
  }> = {};

  if (status !== undefined) {
    updates.status = status;
    if (status === "reviewed" || status === "purchased") {
      updates.reviewedAt = new Date().toISOString();
    }
  }

  if (notes !== undefined) {
    updates.notes = notes;
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: "No fields to update" }, { status: 400 });
  }

  db.update(opportunities).set(updates).where(eq(opportunities.id, numericId)).run();

  return Response.json({ ok: true, id: numericId, ...updates });
}
