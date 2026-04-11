export const dynamic = "force-dynamic";

import { NextRequest } from "next/server";
import { db } from "@/db/client";
import { watchlistItems, products, pricePoints } from "@/db/schema";
import { eq, desc, and } from "drizzle-orm";

export async function GET() {
  const items = db
    .select({
      id: watchlistItems.id,
      productId: watchlistItems.productId,
      targetPricePct: watchlistItems.targetPricePct,
      condition: watchlistItems.condition,
      createdAt: watchlistItems.createdAt,
      triggeredAt: watchlistItems.triggeredAt,
      active: watchlistItems.active,
      notes: watchlistItems.notes,
      productTitle: products.title,
      platform: products.platform,
    })
    .from(watchlistItems)
    .innerJoin(products, eq(watchlistItems.productId, products.id))
    .orderBy(desc(watchlistItems.createdAt))
    .all();

  // Get latest price per product+condition
  const priceRows = db
    .select({
      productId: pricePoints.productId,
      condition: pricePoints.condition,
      priceUsd: pricePoints.priceUsd,
      recordedAt: pricePoints.recordedAt,
    })
    .from(pricePoints)
    .orderBy(desc(pricePoints.recordedAt))
    .all();

  // Build map: productId|condition -> latest price
  const priceMap = new Map<string, number>();
  for (const p of priceRows) {
    const key = `${p.productId}|${p.condition}`;
    if (!priceMap.has(key)) priceMap.set(key, p.priceUsd);
  }

  const result = items.map((item) => {
    const key = `${item.productId}|${item.condition}`;
    const marketPrice = priceMap.get(key) ?? null;
    const targetPrice =
      marketPrice != null
        ? marketPrice * (1 - item.targetPricePct / 100)
        : null;
    const triggered =
      marketPrice != null && targetPrice != null && marketPrice <= targetPrice;

    return {
      ...item,
      marketPrice,
      targetPrice,
      triggered,
    };
  });

  return Response.json(result);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => ({}));
  const { productId, targetPricePct, condition, notes } = body;

  if (!productId || targetPricePct == null) {
    return Response.json(
      { error: "productId and targetPricePct are required" },
      { status: 400 },
    );
  }

  // Validate product exists
  const product = db
    .select({ id: products.id })
    .from(products)
    .where(eq(products.id, productId))
    .get();

  if (!product) {
    return Response.json({ error: "Product not found" }, { status: 404 });
  }

  const result = db
    .insert(watchlistItems)
    .values({
      productId,
      targetPricePct: Number(targetPricePct),
      condition: condition || "loose",
      createdAt: new Date().toISOString(),
      active: true,
      notes: notes || null,
    })
    .returning()
    .get();

  return Response.json(result, { status: 201 });
}
