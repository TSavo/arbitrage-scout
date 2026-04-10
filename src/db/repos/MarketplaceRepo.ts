import { eq } from "drizzle-orm";
import { db } from "../client";
import { marketplaces } from "../schema";
import type { IRepository } from "./IRepository";

export type Marketplace = typeof marketplaces.$inferSelect;
export type NewMarketplace = typeof marketplaces.$inferInsert;

export class MarketplaceRepo implements IRepository<Marketplace, string> {
  async findById(id: string): Promise<Marketplace | null> {
    const row = await db.query.marketplaces.findFirst({
      where: eq(marketplaces.id, id),
    });
    return row ?? null;
  }

  async findAll(opts?: { limit?: number; offset?: number }): Promise<Marketplace[]> {
    return db.query.marketplaces.findMany({
      limit: opts?.limit,
      offset: opts?.offset,
      orderBy: (m, { asc }) => [asc(m.name)],
    });
  }

  async create(data: Omit<Marketplace, "id"> & { id: string }): Promise<Marketplace> {
    const [row] = await db.insert(marketplaces).values(data as NewMarketplace).returning();
    return row;
  }

  async update(id: string, data: Partial<Marketplace>): Promise<Marketplace | null> {
    const [row] = await db
      .update(marketplaces)
      .set(data)
      .where(eq(marketplaces.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(marketplaces)
      .where(eq(marketplaces.id, id))
      .returning({ id: marketplaces.id });
    return result.length > 0;
  }

  async count(): Promise<number> {
    const rows = await db.select({ id: marketplaces.id }).from(marketplaces);
    return rows.length;
  }
}

export const marketplaceRepo = new MarketplaceRepo();
