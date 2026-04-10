export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import {
  opportunities,
  listings,
  listingItems,
  marketplaces,
} from "@/db/schema";
import { desc, eq } from "drizzle-orm";
import { OpportunitiesTable, type OpportunityRow } from "./OpportunitiesTable";

export default async function OpportunitiesPage() {
  const rows = await db
    .select({
      id: opportunities.id,
      listingPriceUsd: opportunities.listingPriceUsd,
      marketPriceUsd: opportunities.marketPriceUsd,
      profitUsd: opportunities.profitUsd,
      marginPct: opportunities.marginPct,
      status: opportunities.status,
      flags: opportunities.flags,
      foundAt: opportunities.foundAt,
      confidence: opportunities.confidence,
      feesUsd: opportunities.feesUsd,
      marketPriceCondition: opportunities.marketPriceCondition,
      marketPriceSource: opportunities.marketPriceSource,
      listingTitle: listings.title,
      url: listings.url,
      marketplaceName: marketplaces.name,
    })
    .from(opportunities)
    .innerJoin(listings, eq(opportunities.listingId, listings.id))
    .innerJoin(marketplaces, eq(listings.marketplaceId, marketplaces.id))
    .orderBy(desc(opportunities.foundAt))
    .limit(500);

  // Fetch condition for first listing item per opportunity
  const itemConditions = await db
    .select({
      listingId: listingItems.listingId,
      condition: listingItems.condition,
    })
    .from(listingItems);

  const conditionByListing = new Map(
    itemConditions.map((i) => [i.listingId, i.condition])
  );

  // Get listing IDs from opportunities
  const listingIds = await db
    .select({ id: listings.id, marketplaceId: listings.marketplaceId })
    .from(listings);

  // Join listing ID back to opportunity by joining directly
  const fullRows = await db
    .select({
      id: opportunities.id,
      listingId: opportunities.listingId,
      listingPriceUsd: opportunities.listingPriceUsd,
      marketPriceUsd: opportunities.marketPriceUsd,
      profitUsd: opportunities.profitUsd,
      marginPct: opportunities.marginPct,
      status: opportunities.status,
      flags: opportunities.flags,
      foundAt: opportunities.foundAt,
      confidence: opportunities.confidence,
      feesUsd: opportunities.feesUsd,
      marketPriceCondition: opportunities.marketPriceCondition,
      marketPriceSource: opportunities.marketPriceSource,
      listingTitle: listings.title,
      url: listings.url,
      marketplaceName: marketplaces.name,
    })
    .from(opportunities)
    .innerJoin(listings, eq(opportunities.listingId, listings.id))
    .innerJoin(marketplaces, eq(listings.marketplaceId, marketplaces.id))
    .orderBy(desc(opportunities.foundAt))
    .limit(500);

  const tableRows: OpportunityRow[] = fullRows.map((r) => ({
    id: r.id,
    listingTitle: r.listingTitle,
    marketplaceName: r.marketplaceName,
    listingPriceUsd: r.listingPriceUsd,
    marketPriceUsd: r.marketPriceUsd,
    profitUsd: r.profitUsd,
    marginPct: r.marginPct,
    status: r.status,
    flags: r.flags as string[],
    foundAt: r.foundAt,
    url: r.url,
    condition: conditionByListing.get(r.listingId) ?? "unknown",
    confidence: r.confidence,
    marketPriceCondition: r.marketPriceCondition,
    marketPriceSource: r.marketPriceSource,
    feesUsd: r.feesUsd,
  }));

  return (
    <div className="p-6 space-y-4">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Opportunities</h2>
        <p className="text-muted-foreground text-sm mt-0.5">
          Underpriced listings across all marketplaces
        </p>
      </div>
      <OpportunitiesTable rows={tableRows} />
    </div>
  );
}
