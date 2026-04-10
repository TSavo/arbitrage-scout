import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../client";
import { opportunities } from "../schema";
import type { IRepository } from "./IRepository";

export type Opportunity = typeof opportunities.$inferSelect;
export type NewOpportunity = typeof opportunities.$inferInsert;

export type OpportunityStatus = "new" | "reviewed" | "purchased" | "passed";

export interface OpportunityStats {
  counts: Record<OpportunityStatus, number>;
  totalProfitUsd: number;
}

export class OpportunityRepo implements IRepository<Opportunity, number> {
  async findById(id: number): Promise<Opportunity | null> {
    const row = await db.query.opportunities.findFirst({
      where: eq(opportunities.id, id),
    });
    return row ?? null;
  }

  async findAll(opts?: { limit?: number; offset?: number }): Promise<Opportunity[]> {
    return db.query.opportunities.findMany({
      limit: opts?.limit,
      offset: opts?.offset,
      orderBy: (o, { desc }) => [desc(o.foundAt)],
    });
  }

  async create(data: Omit<Opportunity, "id">): Promise<Opportunity> {
    const [row] = await db
      .insert(opportunities)
      .values({ ...data, foundAt: data.foundAt ?? new Date().toISOString() } as NewOpportunity)
      .returning();
    return row;
  }

  async update(id: number, data: Partial<Opportunity>): Promise<Opportunity | null> {
    const [row] = await db
      .update(opportunities)
      .set(data)
      .where(eq(opportunities.id, id))
      .returning();
    return row ?? null;
  }

  async delete(id: number): Promise<boolean> {
    const result = await db
      .delete(opportunities)
      .where(eq(opportunities.id, id))
      .returning({ id: opportunities.id });
    return result.length > 0;
  }

  async count(): Promise<number> {
    const rows = await db.select({ id: opportunities.id }).from(opportunities);
    return rows.length;
  }

  /** All opportunities with a given status, most recent first. */
  async findByStatus(
    status: OpportunityStatus,
    opts?: { limit?: number; offset?: number },
  ): Promise<Opportunity[]> {
    return db.query.opportunities.findMany({
      where: eq(opportunities.status, status),
      limit: opts?.limit,
      offset: opts?.offset,
      orderBy: (o, { desc }) => [desc(o.foundAt)],
    });
  }

  /** Mark an opportunity as reviewed / purchased / passed, optionally attaching notes. */
  async updateStatus(
    id: number,
    status: OpportunityStatus,
    notes?: string,
  ): Promise<Opportunity | null> {
    const patch: Partial<Opportunity> = {
      status,
      reviewedAt: new Date().toISOString(),
    };
    if (notes !== undefined) patch.notes = notes;

    const [row] = await db
      .update(opportunities)
      .set(patch)
      .where(eq(opportunities.id, id))
      .returning();
    return row ?? null;
  }

  /** Counts by status and total potential profit across all opportunities. */
  async getStats(): Promise<OpportunityStats> {
    const rows = await db
      .select({
        status: opportunities.status,
        cnt: sql<number>`cast(count(*) as integer)`,
        profit: sql<number>`cast(coalesce(sum(${opportunities.profitUsd}), 0) as real)`,
      })
      .from(opportunities)
      .groupBy(opportunities.status);

    const allStatuses: OpportunityStatus[] = ["new", "reviewed", "purchased", "passed"];
    const counts = Object.fromEntries(allStatuses.map((s) => [s, 0])) as Record<
      OpportunityStatus,
      number
    >;
    let totalProfitUsd = 0;

    for (const row of rows) {
      if (allStatuses.includes(row.status as OpportunityStatus)) {
        counts[row.status as OpportunityStatus] = row.cnt;
      }
      totalProfitUsd += row.profit;
    }

    return { counts, totalProfitUsd };
  }
}

export const opportunityRepo = new OpportunityRepo();
