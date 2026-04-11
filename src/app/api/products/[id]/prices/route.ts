export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import { pricePoints } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

export async function GET(
  _request: Request,
  ctx: RouteContext<"/api/products/[id]/prices">
) {
  const { id } = await ctx.params;

  const rows = db
    .select({
      source: pricePoints.source,
      condition: pricePoints.condition,
      priceUsd: pricePoints.priceUsd,
      recordedAt: pricePoints.recordedAt,
    })
    .from(pricePoints)
    .where(eq(pricePoints.productId, id))
    .orderBy(asc(pricePoints.recordedAt))
    .all();

  return Response.json(rows);
}
