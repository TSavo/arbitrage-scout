import { eq } from "drizzle-orm";
import { db } from "../client";
import { productTypes } from "../schema";
import type { IRepository } from "./IRepository";

export type ProductType = typeof productTypes.$inferSelect;
export type NewProductType = typeof productTypes.$inferInsert;

export interface ProductTypeSchema {
  conditionSchema: string[];
  metadataSchema: string[];
}

export class ProductTypeRepo implements IRepository<ProductType, string> {
  async findById(id: string): Promise<ProductType | null> {
    const row = await db.query.productTypes.findFirst({
      where: eq(productTypes.id, id),
    });
    return row ?? null;
  }

  async findAll(opts?: { limit?: number; offset?: number }): Promise<ProductType[]> {
    return db.query.productTypes.findMany({
      limit: opts?.limit,
      offset: opts?.offset,
      orderBy: (t, { asc }) => [asc(t.name)],
    });
  }

  async create(data: Omit<ProductType, "id"> & { id: string }): Promise<ProductType> {
    const [row] = await db.insert(productTypes).values(data as NewProductType).returning();
    return row;
  }

  async update(id: string, data: Partial<ProductType>): Promise<ProductType | null> {
    const [row] = await db
      .update(productTypes)
      .set(data)
      .where(eq(productTypes.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const result = await db
      .delete(productTypes)
      .where(eq(productTypes.id, id))
      .returning({ id: productTypes.id });
    return result.length > 0;
  }

  async count(): Promise<number> {
    const rows = await db.select({ id: productTypes.id }).from(productTypes);
    return rows.length;
  }

  /** Returns the condition and metadata schema for a product type. */
  async getSchema(id: string): Promise<ProductTypeSchema | null> {
    const row = await this.findById(id);
    if (!row) return null;
    return {
      conditionSchema: row.conditionSchema ?? [],
      metadataSchema: row.metadataSchema ?? [],
    };
  }
}

export const productTypeRepo = new ProductTypeRepo();
