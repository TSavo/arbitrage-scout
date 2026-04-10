import { and, eq } from "drizzle-orm";
import { db } from "../client";
import { listings } from "../schema";
import type { IRepository } from "./IRepository";

export type Listing = typeof listings.$inferSelect;
export type NewListing = typeof listings.$inferInsert;

export class ListingRepo implements IRepository<Listing, number> {
  async findById(id: number): Promise<Listing | null> {
    const row = await db.query.listings.findFirst({
      where: eq(listings.id, id),
    });
    return row ?? null;
  }

  async findAll(opts?: { limit?: number; offset?: number }): Promise<Listing[]> {
    return db.query.listings.findMany({
      limit: opts?.limit,
      offset: opts?.offset,
      orderBy: (l, { desc }) => [desc(l.lastSeenAt)],
    });
  }

  async create(data: Omit<Listing, "id">): Promise<Listing> {
    const now = new Date().toISOString();
    const [row] = await db
      .insert(listings)
      .values({
        ...data,
        firstSeenAt: data.firstSeenAt ?? now,
        lastSeenAt: data.lastSeenAt ?? now,
      } as NewListing)
      .returning();
    return row;
  }

  async update(id: number, data: Partial<Listing>): Promise<Listing | null> {
    const [row] = await db
      .update(listings)
      .set(data)
      .where(eq(listings.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: number): Promise<boolean> {
    const result = await db
      .delete(listings)
      .where(eq(listings.id, id))
      .returning({ id: listings.id });
    return result.length > 0;
  }

  async count(): Promise<number> {
    const rows = await db.select({ id: listings.id }).from(listings);
    return rows.length;
  }

  /**
   * Create or update a listing keyed on (marketplaceId, marketplaceListingId).
   * On conflict, updates price, lastSeenAt, and isActive.
   */
  async upsert(
    marketplaceId: string,
    marketplaceListingId: string,
    data: Omit<Listing, "id" | "marketplaceId" | "marketplaceListingId" | "firstSeenAt">,
  ): Promise<Listing> {
    const now = new Date().toISOString();

    const [row] = await db
      .insert(listings)
      .values({
        marketplaceId,
        marketplaceListingId,
        firstSeenAt: now,
        lastSeenAt: now,
        ...data,
      } as NewListing)
      .onConflictDoUpdate({
        target: [listings.marketplaceId, listings.marketplaceListingId],
        set: {
          title: data.title,
          priceUsd: data.priceUsd,
          shippingUsd: data.shippingUsd,
          seller: data.seller,
          url: data.url,
          description: data.description,
          isLot: data.isLot,
          isActive: data.isActive ?? true,
          lastSeenAt: now,
        },
      })
      .returning();
    return row;
  }

  /**
   * All active listings, optionally filtered by marketplace.
   */
  async findActive(marketplaceId?: string): Promise<Listing[]> {
    const conditions = [eq(listings.isActive, true)];
    if (marketplaceId) {
      conditions.push(eq(listings.marketplaceId, marketplaceId));
    }

    return db.query.listings.findMany({
      where: and(...conditions),
      orderBy: (l, { desc }) => [desc(l.lastSeenAt)],
    });
  }
}

export const listingRepo = new ListingRepo();
