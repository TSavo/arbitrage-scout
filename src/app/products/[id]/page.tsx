export const dynamic = "force-dynamic";

import { db, sqlite } from "@/db/client";
import { products, productTypes, pricePoints, productIdentifiers, opportunities, listings, listingItems } from "@/db/schema";
import { eq, desc, and } from "drizzle-orm";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import Link from "next/link";
import { ProductPriceChart } from "./ProductPriceChart";

export default async function ProductDetailPage(
  props: PageProps<"/products/[id]">
) {
  const { id } = await props.params;

  // Fetch product
  const product = db
    .select()
    .from(products)
    .where(eq(products.id, id))
    .get();

  if (!product) notFound();

  // Fetch product type
  const productType = db
    .select()
    .from(productTypes)
    .where(eq(productTypes.id, product.productTypeId))
    .get();

  // Fetch identifiers
  const identifiers = db
    .select()
    .from(productIdentifiers)
    .where(eq(productIdentifiers.productId, id))
    .all();

  // Fetch all price points for chart
  const prices = db
    .select({
      source: pricePoints.source,
      condition: pricePoints.condition,
      priceUsd: pricePoints.priceUsd,
      recordedAt: pricePoints.recordedAt,
    })
    .from(pricePoints)
    .where(eq(pricePoints.productId, id))
    .orderBy(pricePoints.recordedAt)
    .all();

  // Latest price per condition
  const latestPrices = new Map<string, { price: number; source: string; date: string }>();
  for (const p of prices) {
    const key = p.condition;
    latestPrices.set(key, { price: p.priceUsd, source: p.source, date: p.recordedAt });
  }

  // Build chart data: pivot by date, one column per "source:condition"
  const dateMap = new Map<string, Record<string, number>>();
  const seriesKeys = new Set<string>();
  for (const p of prices) {
    const date = p.recordedAt.slice(0, 10); // YYYY-MM-DD
    const key = `${p.source} ${p.condition}`;
    seriesKeys.add(key);
    if (!dateMap.has(date)) dateMap.set(date, {});
    dateMap.get(date)![key] = p.priceUsd;
  }
  const chartData = Array.from(dateMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, vals]) => ({ date, ...vals }));

  // Fetch related opportunities
  const relatedOpps = db
    .select({
      id: opportunities.id,
      listingPriceUsd: opportunities.listingPriceUsd,
      marketPriceUsd: opportunities.marketPriceUsd,
      profitUsd: opportunities.profitUsd,
      marginPct: opportunities.marginPct,
      status: opportunities.status,
      foundAt: opportunities.foundAt,
      marketPriceSource: opportunities.marketPriceSource,
      marketPriceCondition: opportunities.marketPriceCondition,
    })
    .from(opportunities)
    .where(eq(opportunities.productId, id))
    .orderBy(desc(opportunities.foundAt))
    .limit(20)
    .all();

  // Fetch listings that matched this product
  const matchedListings = db
    .select({
      listingId: listingItems.listingId,
      confidence: listingItems.confidence,
      confirmed: listingItems.confirmed,
      condition: listingItems.condition,
      estimatedValueUsd: listingItems.estimatedValueUsd,
      listingTitle: listings.title,
      listingPrice: listings.priceUsd,
      marketplace: listings.marketplaceId,
      url: listings.url,
      lastSeen: listings.lastSeenAt,
    })
    .from(listingItems)
    .innerJoin(listings, eq(listingItems.listingId, listings.id))
    .where(eq(listingItems.productId, id))
    .orderBy(desc(listings.lastSeenAt))
    .limit(20)
    .all();

  return (
    <div className="p-6 space-y-6 max-w-6xl">
      {/* Header */}
      <div>
        <Link href="/products" className="text-xs text-muted-foreground hover:text-foreground transition-colors">
          &larr; Products
        </Link>
        <h2 className="text-2xl font-semibold tracking-tight mt-2">{product.title}</h2>
        <div className="flex items-center gap-2 mt-1">
          {product.platform && (
            <Badge variant="outline">{product.platform}</Badge>
          )}
          <Badge variant="secondary" className="text-xs font-mono">
            {product.productTypeId}
          </Badge>
          {product.salesVolume > 0 && (
            <span className="text-xs text-muted-foreground">
              {product.salesVolume.toLocaleString()} sales/yr
            </span>
          )}
        </div>
      </div>

      {/* Current Prices */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {Array.from(latestPrices.entries()).map(([condition, { price, source, date }]) => (
          <Card key={condition} className="bg-card/50">
            <CardContent className="pt-4 pb-3">
              <span className="text-xs text-muted-foreground capitalize">{condition.replace(/_/g, " ")}</span>
              <p className="text-xl font-mono font-semibold mt-0.5">${price.toFixed(2)}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">{source} &middot; {date}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Price Chart */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Price History</CardTitle>
          <p className="text-xs text-muted-foreground">
            {prices.length} data points across {seriesKeys.size} series
          </p>
        </CardHeader>
        <CardContent>
          <ProductPriceChart
            data={chartData}
            seriesKeys={Array.from(seriesKeys)}
          />
        </CardContent>
      </Card>

      {/* Identifiers */}
      {identifiers.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Identifiers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {identifiers.map((ident) => (
                <div key={`${ident.identifierType}-${ident.identifierValue}`} className="text-sm">
                  <span className="text-xs text-muted-foreground uppercase">{ident.identifierType}</span>
                  <p className="font-mono text-xs mt-0.5">{ident.identifierValue}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Opportunities */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Opportunities
              {relatedOpps.length > 0 && (
                <Badge variant="secondary" className="ml-2 text-xs">{relatedOpps.length}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {relatedOpps.length === 0 ? (
              <p className="text-sm text-muted-foreground">No opportunities found yet</p>
            ) : (
              <div className="space-y-2">
                {relatedOpps.map((opp) => (
                  <div key={opp.id} className="flex items-center justify-between text-sm border-b border-border/50 pb-2 last:border-0">
                    <div>
                      <span className="font-mono text-green-400 font-medium">
                        +${opp.profitUsd.toFixed(2)}
                      </span>
                      <span className="text-muted-foreground ml-2 text-xs">
                        ({(opp.marginPct * 100).toFixed(0)}% margin)
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={opp.status === "new" ? "default" : "secondary"} className="text-[10px]">
                        {opp.status}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">
                        {opp.foundAt.slice(0, 10)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Matched Listings */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Matched Listings
              {matchedListings.length > 0 && (
                <Badge variant="secondary" className="ml-2 text-xs">{matchedListings.length}</Badge>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {matchedListings.length === 0 ? (
              <p className="text-sm text-muted-foreground">No listings matched yet</p>
            ) : (
              <div className="space-y-2">
                {matchedListings.map((l, i) => (
                  <div key={i} className="flex items-center justify-between text-sm border-b border-border/50 pb-2 last:border-0">
                    <div className="min-w-0 flex-1 mr-3">
                      {l.url ? (
                        <a href={l.url} target="_blank" rel="noopener noreferrer"
                          className="text-blue-400 hover:underline text-xs truncate block">
                          {l.listingTitle}
                        </a>
                      ) : (
                        <span className="text-xs truncate block">{l.listingTitle}</span>
                      )}
                      <div className="flex items-center gap-2 mt-0.5">
                        <Badge variant="outline" className="text-[10px]">{l.marketplace}</Badge>
                        <span className="font-mono text-xs">${l.listingPrice.toFixed(2)}</span>
                        {l.confirmed ? (
                          <span className="text-[10px] text-green-400">confirmed</span>
                        ) : (
                          <span className="text-[10px] text-yellow-400">unconfirmed</span>
                        )}
                      </div>
                    </div>
                    <span className="text-[10px] text-muted-foreground whitespace-nowrap">
                      {l.lastSeen.slice(0, 10)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
