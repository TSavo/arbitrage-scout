export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import { sql } from "drizzle-orm";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

type CategoryStat = {
  id: string;
  name: string;
  product_count: number;
  opportunity_count: number;
  avg_loose: number | null;
  total_volume: number;
};

export default async function CategoriesPage() {
  let categories: CategoryStat[] = [];

  try {
    categories = db.all(sql`
      SELECT
        pt.id,
        pt.name,
        COUNT(DISTINCT p.id) as product_count,
        COUNT(DISTINCT CASE WHEN o.status = 'new' THEN o.id END) as opportunity_count,
        ROUND(AVG(CASE WHEN pp.condition = 'loose' AND pp.recorded_at = (
          SELECT MAX(pp2.recorded_at) FROM price_points pp2
          WHERE pp2.product_id = p.id AND pp2.condition = 'loose'
        ) THEN pp.price_usd END), 2) as avg_loose,
        COALESCE(SUM(p.sales_volume), 0) as total_volume
      FROM product_types pt
      LEFT JOIN products p ON p.product_type_id = pt.id
      LEFT JOIN opportunities o ON o.product_id = p.id AND o.status = 'new'
      LEFT JOIN price_points pp ON pp.product_id = p.id
      GROUP BY pt.id, pt.name
      ORDER BY COUNT(DISTINCT p.id) DESC
    `) as CategoryStat[];
  } catch {
    // Tables might not exist yet
  }

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Categories</h2>
        <p className="text-muted-foreground text-sm mt-0.5">
          Product types across the collectibles market
        </p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {categories.map((cat) => (
          <Link key={cat.id} href={`/categories/${cat.id}`}>
            <Card className="hover:bg-muted/30 transition-colors cursor-pointer h-full">
              <CardContent className="pt-5 pb-4 space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-sm">{cat.name}</span>
                  {cat.opportunity_count > 0 && (
                    <Badge variant="default" className="text-[10px]">
                      {cat.opportunity_count} deal{cat.opportunity_count !== 1 ? "s" : ""}
                    </Badge>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                  <div>
                    <span className="text-muted-foreground">Products</span>
                    <p className="font-mono">{cat.product_count.toLocaleString()}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Avg Price</span>
                    <p className="font-mono">
                      {cat.avg_loose != null ? `$${cat.avg_loose.toFixed(2)}` : "—"}
                    </p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Volume</span>
                    <p className="font-mono">{cat.total_volume.toLocaleString()}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Type</span>
                    <p className="font-mono text-[10px]">{cat.id}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>

      {categories.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-12">
          No product types found. Run the import pipeline first.
        </p>
      )}
    </div>
  );
}
