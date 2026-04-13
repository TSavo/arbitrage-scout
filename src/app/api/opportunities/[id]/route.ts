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
  const { status, notes, buyPriceUsd, salePriceUsd, saleDate, actualFeesUsd } = body;

  if (status !== undefined && !VALID_STATUSES.includes(status)) {
    return Response.json(
      { error: `Invalid status. Must be one of: ${VALID_STATUSES.join(", ")}` },
      { status: 400 }
    );
  }

  // Validate prices are positive numbers if provided
  for (const [field, value] of Object.entries({ buyPriceUsd, salePriceUsd, actualFeesUsd })) {
    if (value !== undefined && (typeof value !== "number" || value < 0)) {
      return Response.json(
        { error: `${field} must be a non-negative number` },
        { status: 400 }
      );
    }
  }

  const updates: Partial<{
    status: string;
    notes: string;
    reviewedAt: string;
    buyPriceUsd: number;
    salePriceUsd: number;
    saleDate: string;
    actualFeesUsd: number;
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

  if (buyPriceUsd !== undefined) {
    updates.buyPriceUsd = buyPriceUsd;
  }

  if (salePriceUsd !== undefined) {
    updates.salePriceUsd = salePriceUsd;
  }

  if (saleDate !== undefined) {
    updates.saleDate = saleDate;
  }

  if (actualFeesUsd !== undefined) {
    updates.actualFeesUsd = actualFeesUsd;
  }

  if (Object.keys(updates).length === 0) {
    return Response.json({ error: "No fields to update" }, { status: 400 });
  }

  await db.update(opportunities).set(updates).where(eq(opportunities.id, numericId));

  return Response.json({ ok: true, id: numericId, ...updates });
}
