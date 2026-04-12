import { and, asc, desc, eq, gte, like, or, sql } from "drizzle-orm";
import { db } from "../client";
import { pricePoints, products, taxonomyNodes } from "../schema";
import type { IRepository } from "./IRepository";

export type PricePoint = typeof pricePoints.$inferSelect;
export type NewPricePoint = typeof pricePoints.$inferInsert;

export class PricePointRepo implements IRepository<PricePoint, number> {
  async findById(id: number): Promise<PricePoint | null> {
    const row = await db.query.pricePoints.findFirst({
      where: eq(pricePoints.id, id),
    });
    return row ?? null;
  }

  async findAll(opts?: { limit?: number; offset?: number }): Promise<PricePoint[]> {
    return db.query.pricePoints.findMany({
      limit: opts?.limit,
      offset: opts?.offset,
      orderBy: (pp, { desc }) => [desc(pp.recordedAt)],
    });
  }

  async create(data: Omit<PricePoint, "id">): Promise<PricePoint> {
    const [row] = await db
      .insert(pricePoints)
      .values({ ...data, recordedAt: data.recordedAt ?? new Date().toISOString() } as NewPricePoint)
      .returning();
    return row;
  }

  async update(id: number, data: Partial<PricePoint>): Promise<PricePoint | null> {
    const [row] = await db
      .update(pricePoints)
      .set(data)
      .where(eq(pricePoints.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: number): Promise<boolean> {
    const result = await db
      .delete(pricePoints)
      .where(eq(pricePoints.id, id))
      .returning({ id: pricePoints.id });
    return result.length > 0;
  }

  async count(): Promise<number> {
    const rows = await db.select({ id: pricePoints.id }).from(pricePoints);
    return rows.length;
  }

  /**
   * Most recent price for a product + condition combination.
   * Returns null if no price exists.
   */
  async getLatestPrice(productId: string, condition: string): Promise<PricePoint | null> {
    const row = await db.query.pricePoints.findFirst({
      where: and(
        eq(pricePoints.productId, productId),
        eq(pricePoints.condition, condition),
      ),
      orderBy: (pp, { desc }) => [desc(pp.recordedAt)],
    });
    return row ?? null;
  }

  /**
   * Price history for a product, optionally filtered by condition and recency.
   * Returns rows in ascending chronological order (oldest first).
   */
  async getPriceHistory(
    productId: string,
    condition?: string,
    days?: number,
  ): Promise<PricePoint[]> {
    const conditions = [eq(pricePoints.productId, productId)];

    if (condition) {
      conditions.push(eq(pricePoints.condition, condition));
    }

    if (days !== undefined) {
      const cutoff = new Date(Date.now() - days * 86_400_000).toISOString();
      conditions.push(gte(pricePoints.recordedAt, cutoff));
    }

    return db.query.pricePoints.findMany({
      where: and(...conditions),
      orderBy: (pp, { asc }) => [asc(pp.recordedAt)],
    });
  }
  /**
   * Get price changes between the two most recent distinct recordedAt dates.
   * Used by trend detection to surface products with significant movement.
   */
  async findPriceChanges(opts: {
    condition: string;
    minPriceUsd: number;
    limit: number;
  }): Promise<
    Array<{
      productId: string;
      oldPrice: number;
      newPrice: number;
      oldDate: string;
      newDate: string;
    }>
  > {
    // Find the two most recent distinct dates
    const dates = await db
      .selectDistinct({ recordedAt: pricePoints.recordedAt })
      .from(pricePoints)
      .where(
        and(
          eq(pricePoints.condition, opts.condition),
          eq(pricePoints.source, "pricecharting"),
        ),
      )
      .orderBy(desc(pricePoints.recordedAt))
      .limit(2);

    if (dates.length < 2) return [];

    const newDate = dates[0].recordedAt;
    const oldDate = dates[1].recordedAt;

    // Join price_points to itself on the two dates
    const ppNew = db
      .select({
        productId: pricePoints.productId,
        priceUsd: pricePoints.priceUsd,
      })
      .from(pricePoints)
      .where(
        and(
          eq(pricePoints.condition, opts.condition),
          eq(pricePoints.recordedAt, newDate),
        ),
      )
      .as("pp_new");

    const ppOld = db
      .select({
        productId: pricePoints.productId,
        priceUsd: pricePoints.priceUsd,
      })
      .from(pricePoints)
      .where(
        and(
          eq(pricePoints.condition, opts.condition),
          eq(pricePoints.recordedAt, oldDate),
        ),
      )
      .as("pp_old");

    const rows = await db
      .select({
        productId: ppNew.productId,
        oldPrice: ppOld.priceUsd,
        newPrice: ppNew.priceUsd,
      })
      .from(ppNew)
      .innerJoin(ppOld, eq(ppNew.productId, ppOld.productId))
      .where(gte(ppOld.priceUsd, opts.minPriceUsd))
      .limit(opts.limit);

    return rows.map((r) => ({
      productId: r.productId,
      oldPrice: r.oldPrice,
      newPrice: r.newPrice,
      oldDate,
      newDate,
    }));
  }

  /**
   * Get all latest prices (most recent per product+source+condition).
   * Used by arbitrage to compare prices across sources.
   */
  async findLatestPricesBySource(opts?: {
    condition?: string;
    /** Taxonomy subtree filter: match products under a node (by id or slug-path prefix). */
    taxonomyNodeId?: number;
  }): Promise<
    Array<{
      productId: string;
      source: string;
      condition: string;
      priceUsd: number;
      recordedAt: string;
    }>
  > {
    // Subquery: max recordedAt per product+source+condition
    const maxDates = db
      .select({
        productId: pricePoints.productId,
        source: pricePoints.source,
        condition: pricePoints.condition,
        maxDate: sql<string>`max(${pricePoints.recordedAt})`.as("max_date"),
      })
      .from(pricePoints)
      .groupBy(pricePoints.productId, pricePoints.source, pricePoints.condition)
      .as("max_dates");

    const conditions = [
      eq(pricePoints.productId, maxDates.productId),
      eq(pricePoints.source, maxDates.source),
      eq(pricePoints.condition, maxDates.condition),
      eq(pricePoints.recordedAt, maxDates.maxDate),
    ];

    if (opts?.condition) {
      conditions.push(eq(pricePoints.condition, opts.condition));
    }

    let query = db
      .select({
        productId: pricePoints.productId,
        source: pricePoints.source,
        condition: pricePoints.condition,
        priceUsd: pricePoints.priceUsd,
        recordedAt: pricePoints.recordedAt,
      })
      .from(pricePoints)
      .innerJoin(maxDates, and(...conditions));

    if (opts?.taxonomyNodeId) {
      // Subtree filter: products whose taxonomy node is this node or any
      // descendant. path_cache uses slug paths — match the node's own
      // path_cache as a prefix.
      const root = await db.query.taxonomyNodes.findFirst({
        where: eq(taxonomyNodes.id, opts.taxonomyNodeId),
        columns: { pathCache: true },
      });
      if (!root) return [];
      const prefix = `${root.pathCache}%`;

      return db
        .select({
          productId: pricePoints.productId,
          source: pricePoints.source,
          condition: pricePoints.condition,
          priceUsd: pricePoints.priceUsd,
          recordedAt: pricePoints.recordedAt,
        })
        .from(pricePoints)
        .innerJoin(maxDates, and(
          eq(pricePoints.productId, maxDates.productId),
          eq(pricePoints.source, maxDates.source),
          eq(pricePoints.condition, maxDates.condition),
          eq(pricePoints.recordedAt, maxDates.maxDate),
        ))
        .innerJoin(products, eq(pricePoints.productId, products.id))
        .innerJoin(taxonomyNodes, eq(products.taxonomyNodeId, taxonomyNodes.id))
        .where(
          and(
            like(taxonomyNodes.pathCache, prefix),
            ...(opts?.condition ? [eq(pricePoints.condition, opts.condition)] : []),
          ),
        );
    }

    return query;
  }
}

export const pricePointRepo = new PricePointRepo();
