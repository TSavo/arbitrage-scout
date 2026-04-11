import { and, desc, eq, gte, lte, like, sql } from "drizzle-orm";
import { db } from "../client";
import { products, pricePoints } from "../schema";
import type { IRepository } from "./IRepository";

export type Product = typeof products.$inferSelect;
export type NewProduct = typeof products.$inferInsert;

export interface FindByTypeOpts {
  limit?: number;
  offset?: number;
}

export interface FindTopByVolumeOpts {
  productTypeId?: string;
  minPrice?: number;
  maxPrice?: number;
  limit?: number;
}

export interface SearchOpts {
  productTypeId?: string;
  limit?: number;
  offset?: number;
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

  /** Filter products by product type. */
  async findByType(productTypeId: string, opts?: FindByTypeOpts): Promise<Product[]> {
    return db.query.products.findMany({
      where: eq(products.productTypeId, productTypeId),
      limit: opts?.limit,
      offset: opts?.offset,
      orderBy: (p, { desc }) => [desc(p.salesVolume)],
    });
  }

  /**
   * Top products by sales volume, optionally filtered by type and price range.
   * Joins to pricePoints to apply price filters. Used for query generation.
   */
  async findTopByVolume(opts: FindTopByVolumeOpts = {}): Promise<Product[]> {
    const { productTypeId, minPrice, maxPrice, limit = 50 } = opts;

    const conditions = [];
    if (productTypeId) {
      conditions.push(eq(products.productTypeId, productTypeId));
    }

    if (minPrice !== undefined || maxPrice !== undefined) {
      // Join through pricePoints — return products that have at least one price in range
      const priceConditions = [];
      if (minPrice !== undefined) priceConditions.push(gte(pricePoints.priceUsd, minPrice));
      if (maxPrice !== undefined) priceConditions.push(lte(pricePoints.priceUsd, maxPrice));

      const subquery = db
        .selectDistinct({ productId: pricePoints.productId })
        .from(pricePoints)
        .where(and(...priceConditions));

      conditions.push(
        sql`${products.id} IN (${subquery})`
      );
    }

    return db.query.products.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      limit,
      orderBy: (p, { desc }) => [desc(p.salesVolume)],
    });
  }

  /**
   * Full-text search on title using LIKE. For FTS5, use the sqlite raw connection directly.
   * Optionally narrows by product type.
   */
  async search(query: string, opts?: SearchOpts): Promise<Product[]> {
    const pattern = `%${query}%`;
    const conditions = [like(products.title, pattern)];

    if (opts?.productTypeId) {
      conditions.push(eq(products.productTypeId, opts.productTypeId));
    }

    return db.query.products.findMany({
      where: and(...conditions),
      limit: opts?.limit ?? 20,
      offset: opts?.offset,
      orderBy: (p, { desc }) => [desc(p.salesVolume)],
    });
  }
  /**
   * Get platform statistics aggregated by platform and product type.
   * Joins products with price_points to compute aggregates.
   */
  async getPlatformStats(): Promise<
    Array<{
      platform: string;
      productTypeId: string;
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
        productTypeId: products.productTypeId,
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
      .groupBy(products.platform, products.productTypeId)
      .having(sql`count(distinct ${products.id}) >= 20`)
      .orderBy(sql`avg(${products.salesVolume}) desc`);

    return rows.map((r) => ({
      platform: r.platform ?? "",
      productTypeId: r.productTypeId,
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
