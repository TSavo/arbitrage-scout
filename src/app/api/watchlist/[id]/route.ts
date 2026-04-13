export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { db } from "@/db/client";
import { watchlistItems } from "@/db/schema";
import { eq } from "drizzle-orm";

export async function PATCH(
  request: NextRequest,
  ctx: RouteContext<"/api/watchlist/[id]">,
) {
  const { id } = await ctx.params;
  const numericId = parseInt(id, 10);

  if (isNaN(numericId)) {
    return Response.json({ error: "Invalid ID" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({}));
  const { targetPricePct, active, notes } = body;

  const updates: Partial<{
    targetPricePct: number;
    active: boolean;
    notes: string | null;
    triggeredAt: string | null;
  }> = {};

  if (targetPricePct !== undefined) updates.targetPricePct = Number(targetPricePct);
  if (active !== undefined) updates.active = Boolean(active);
  if (notes !== undefined) updates.notes = notes;

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: "No fields to update" }, { status: 400 });
  }

  await db.update(watchlistItems)
    .set(updates)
    .where(eq(watchlistItems.id, numericId));

  return Response.json({ ok: true, id: numericId, ...updates });
}

export async function DELETE(
  _request: NextRequest,
  ctx: RouteContext<"/api/watchlist/[id]">,
) {
  const { id } = await ctx.params;
  const numericId = parseInt(id, 10);

  if (isNaN(numericId)) {
    return Response.json({ error: "Invalid ID" }, { status: 400 });
  }

  await db.delete(watchlistItems).where(eq(watchlistItems.id, numericId));

  return Response.json({ ok: true, id: numericId });
}
