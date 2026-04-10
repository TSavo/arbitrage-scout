export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import { products, productTypes, pricePoints } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ProductsClient } from "./ProductsClient";

export default async function ProductsPage() {
  const rows = await db
    .select({
      id: products.id,
      title: products.title,
      platform: products.platform,
      productTypeId: products.productTypeId,
      salesVolume: products.salesVolume,
      createdAt: products.createdAt,
    })
    .from(products)
    .orderBy(desc(products.salesVolume))
    .limit(500);

  // Get latest price points per product (loose/CIB/new)
  const prices = await db
    .select({
      productId: pricePoints.productId,
      condition: pricePoints.condition,
      priceUsd: pricePoints.priceUsd,
      recordedAt: pricePoints.recordedAt,
    })
    .from(pricePoints)
    .orderBy(desc(pricePoints.recordedAt));

  // Build map: productId -> condition -> latest price
  const priceMap = new Map<string, Record<string, number>>();
  for (const p of prices) {
    if (!priceMap.has(p.productId)) priceMap.set(p.productId, {});
    const cond = priceMap.get(p.productId)!;
    if (!(p.condition in cond)) cond[p.condition] = p.priceUsd;
  }

  const tableRows = rows.map((r) => ({
    ...r,
    prices: priceMap.get(r.id) ?? {},
  }));

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Products</h2>
        <p className="text-muted-foreground text-sm mt-0.5">
          Price catalog — {rows.length} items
        </p>
      </div>
      <ProductsClient rows={tableRows} />
    </div>
  );
}
