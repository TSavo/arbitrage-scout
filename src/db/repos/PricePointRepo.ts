import { and, desc, eq, gte, sql } from "drizzle-orm";
import { db } from "../client";
import { pricePoints } from "../schema";
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
}

export const pricePointRepo = new PricePointRepo();
