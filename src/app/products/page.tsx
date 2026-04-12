export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import { products, pricePoints, taxonomyNodes } from "@/db/schema";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { taxonomyRepo } from "@/db/repos/TaxonomyRepo";
import { ProductsClient } from "./ProductsClient";

export default async function ProductsPage(
  props: PageProps<"/products">
) {
  const searchParams = await props.searchParams;
  const nodeParam = Array.isArray(searchParams?.node)
    ? searchParams.node[0]
    : searchParams?.node;
  const nodeIdNum = nodeParam ? Number(nodeParam) : NaN;
  const filterNode =
    Number.isFinite(nodeIdNum) && Number.isInteger(nodeIdNum)
      ? await taxonomyRepo.getNode(nodeIdNum)
      : null;

  // Build base query: join products → taxonomy_nodes so we can display the
  // node's label / path and (optionally) filter by subtree in a single pass.
  const whereSubtree = filterNode
    ? or(
        eq(taxonomyNodes.pathCache, filterNode.pathCache),
        like(taxonomyNodes.pathCache, `${filterNode.pathCache}/%`),
      )
    : undefined;

  const rows = await db
    .select({
      id: products.id,
      title: products.title,
      platform: products.platform,
      taxonomyNodeId: products.taxonomyNodeId,
      taxonomyLabel: taxonomyNodes.label,
      taxonomyPath: taxonomyNodes.pathCache,
      salesVolume: products.salesVolume,
      createdAt: products.createdAt,
    })
    .from(products)
    .leftJoin(taxonomyNodes, eq(taxonomyNodes.id, products.taxonomyNodeId))
    .where(whereSubtree ? and(whereSubtree) : undefined)
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
  const historyMap = new Map<string, { date: string; value: number }[]>();
  for (const p of prices) {
    if (!priceMap.has(p.productId)) priceMap.set(p.productId, {});
    const cond = priceMap.get(p.productId)!;
    if (!(p.condition in cond)) cond[p.condition] = p.priceUsd;

    if (p.condition === "loose") {
      if (!historyMap.has(p.productId)) historyMap.set(p.productId, []);
      historyMap.get(p.productId)!.push({ date: p.recordedAt, value: p.priceUsd });
    }
  }
  for (const [, arr] of historyMap) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
  }

  const tableRows = rows.map((r) => ({
    ...r,
    prices: priceMap.get(r.id) ?? {},
    priceHistory: historyMap.get(r.id)?.map(({ value }) => ({ value })),
  }));

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Products</h2>
        <p className="text-muted-foreground text-sm mt-0.5">
          Price catalog — {rows.length} items
          {filterNode && (
            <>
              {" "}— filtered to{" "}
              <span className="font-mono">{filterNode.pathCache}</span>
            </>
          )}
        </p>
      </div>
      <ProductsClient rows={tableRows} activeNodeId={filterNode?.id ?? null} />
    </div>
  );
}
