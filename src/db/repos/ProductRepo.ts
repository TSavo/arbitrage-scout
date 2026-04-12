import { and, desc, eq, gte, lte, like, sql } from "drizzle-orm";
import { db } from "../client";
import { products, pricePoints, taxonomyNodes } from "../schema";
import type { IRepository } from "./IRepository";

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

export interface FindByNodeOpts {
  limit?: number;
  offset?: number;
}

export interface FindTopByVolumeOpts {
  /** Taxonomy subtree: match products whose taxonomy node is this node or any descendant. */
  taxonomyNodeId?: number;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
}

export interface SearchOpts {
  taxonomyNodeId?: number;
  limit?: number;
  offset?: number;
}

/**
 * Resolve a taxonomy node id to its path_cache prefix for subtree queries.
 * Returns null if the node doesn't exist.
 */
async function subtreePrefix(nodeId: number): Promise<string | null> {
  const row = await db.query.taxonomyNodes.findFirst({
    where: eq(taxonomyNodes.id, nodeId),
    columns: { pathCache: true },
  });
  return row ? `${row.pathCache}%` : null;
}

export class ProductRepo implements IRepository<Product, string> {
  async findById(id: string): Promise<Product | null> {
    const row = await db.query.products.findFirst({
      where: eq(products.id, id),
    });
    return row ?? null;
  }

  async findAll(opts?: { limit?: number; offset?: number }): Promise<Product[]> {
    return db.query.products.findMany({
      limit: opts?.limit,
      offset: opts?.offset,
      orderBy: (p, { desc }) => [desc(p.salesVolume)],
    });
  }

  async create(data: Omit<Product, never>): Promise<Product> {
    const now = new Date().toISOString();
    const [row] = await db
      .insert(products)
      .values({ ...data, createdAt: data.createdAt ?? now, updatedAt: data.updatedAt ?? now } as NewProduct)
      .returning();
    return row;
  }

  async update(id: string, data: Partial<Product>): Promise<Product | null> {
    const [row] = await db
      .update(products)
      .set({ ...data, updatedAt: new Date().toISOString() })
      .where(eq(products.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(products)
      .where(eq(products.id, id))
      .returning({ id: products.id });
    return result.length > 0;
  }

  async count(): Promise<number> {
    const rows = await db.select({ id: products.id }).from(products);
    return rows.length;
  }

  /** Filter products by taxonomy subtree (the node itself + descendants). */
  async findByNode(taxonomyNodeId: number, opts?: FindByNodeOpts): Promise<Product[]> {
    const prefix = await subtreePrefix(taxonomyNodeId);
    if (!prefix) return [];
    const rows = db
      .select()
      .from(products)
      .innerJoin(taxonomyNodes, eq(products.taxonomyNodeId, taxonomyNodes.id))
      .where(like(taxonomyNodes.pathCache, prefix))
      .orderBy(desc(products.salesVolume))
      .limit(opts?.limit ?? 1000)
      .offset(opts?.offset ?? 0)
      .all();
    return rows.map((r) => r.products);
  }

  /**
   * Top products by sales volume, optionally filtered by taxonomy subtree and price range.
   * Joins to pricePoints to apply price filters. Used for query generation.
   */
  async findTopByVolume(opts: FindTopByVolumeOpts = {}): Promise<Product[]> {
    const { taxonomyNodeId, minPrice, maxPrice, limit = 50 } = opts;

    const conditions = [];
    let prefix: string | null = null;
    if (taxonomyNodeId !== undefined) {
      prefix = await subtreePrefix(taxonomyNodeId);
      if (!prefix) return [];
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      const priceConditions = [];
      if (minPrice !== undefined) priceConditions.push(gte(pricePoints.priceUsd, minPrice));
      if (maxPrice !== undefined) priceConditions.push(lte(pricePoints.priceUsd, maxPrice));

      const subquery = db
        .selectDistinct({ productId: pricePoints.productId })
        .from(pricePoints)
        .where(and(...priceConditions));

      conditions.push(sql`${products.id} IN (${subquery})`);
    }

    if (prefix) {
      const rows = db
        .select()
        .from(products)
        .innerJoin(taxonomyNodes, eq(products.taxonomyNodeId, taxonomyNodes.id))
        .where(and(like(taxonomyNodes.pathCache, prefix), ...conditions))
        .orderBy(desc(products.salesVolume))
        .limit(limit)
        .all();
      return rows.map((r) => r.products);
    }

    return db.query.products.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      limit,
      orderBy: (p, { desc }) => [desc(p.salesVolume)],
    });
  }

  /**
   * Full-text search on title using LIKE.
   * Optionally narrows by taxonomy subtree.
   */
  async search(query: string, opts?: SearchOpts): Promise<Product[]> {
    const pattern = `%${query}%`;

    if (opts?.taxonomyNodeId !== undefined) {
      const prefix = await subtreePrefix(opts.taxonomyNodeId);
      if (!prefix) return [];
      const rows = db
        .select()
        .from(products)
        .innerJoin(taxonomyNodes, eq(products.taxonomyNodeId, taxonomyNodes.id))
        .where(and(like(products.title, pattern), like(taxonomyNodes.pathCache, prefix)))
        .orderBy(desc(products.salesVolume))
        .limit(opts?.limit ?? 20)
        .offset(opts?.offset ?? 0)
        .all();
      return rows.map((r) => r.products);
    }

    return db.query.products.findMany({
      where: like(products.title, pattern),
      limit: opts?.limit ?? 20,
      offset: opts?.offset,
      orderBy: (p, { desc }) => [desc(p.salesVolume)],
    });
  }

  /**
   * Platform statistics aggregated by platform and taxonomy node.
   * Useful for breakdowns like "retro games by console" — the node
   * label is the bucket label.
   */
  async getPlatformStats(): Promise<
    Array<{
      platform: string;
      nodeId: number | null;
      nodeLabel: string;
      nodePath: string;
      productCount: number;
      avgLoose: number;
      totalVolume: number;
      avgVolume: number;
      pctAbove50: number;
      pctAbove100: number;
    }>
  > {
    const rows = await db
      .select({
        platform: products.platform,
        nodeId: products.taxonomyNodeId,
        nodeLabel: taxonomyNodes.label,
        nodePath: taxonomyNodes.pathCache,
        productCount: sql<number>`cast(count(distinct ${products.id}) as integer)`,
        avgLoose: sql<number>`round(avg(${pricePoints.priceUsd}), 2)`,
        totalVolume: sql<number>`cast(coalesce(sum(${products.salesVolume}), 0) as integer)`,
        avgVolume: sql<number>`round(avg(${products.salesVolume}), 1)`,
        pctAbove50: sql<number>`round(sum(case when ${pricePoints.priceUsd} >= 50 then 1 else 0 end) * 100.0 / count(*), 1)`,
        pctAbove100: sql<number>`round(sum(case when ${pricePoints.priceUsd} >= 100 then 1 else 0 end) * 100.0 / count(*), 1)`,
      })
      .from(products)
      .innerJoin(
        pricePoints,
        and(
          eq(pricePoints.productId, products.id),
          eq(pricePoints.condition, "loose"),
          gte(pricePoints.priceUsd, 0.01),
        ),
      )
      .innerJoin(taxonomyNodes, eq(products.taxonomyNodeId, taxonomyNodes.id))
      .groupBy(products.platform, products.taxonomyNodeId, taxonomyNodes.label, taxonomyNodes.pathCache)
      .having(sql`count(distinct ${products.id}) >= 20`)
      .orderBy(sql`avg(${products.salesVolume}) desc`);

    return rows.map((r) => ({
      platform: r.platform ?? "",
      nodeId: r.nodeId ?? null,
      nodeLabel: r.nodeLabel ?? "",
      nodePath: r.nodePath ?? "",
      productCount: r.productCount,
      avgLoose: r.avgLoose,
      totalVolume: r.totalVolume,
      avgVolume: r.avgVolume,
      pctAbove50: r.pctAbove50,
      pctAbove100: r.pctAbove100,
    }));
  }
}

export const productRepo = new ProductRepo();
