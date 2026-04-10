export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import { sqlite } from "@/db/client";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";

function fmt(n: number) {
  return `$${n.toFixed(0)}`;
}

type PlatformStat = {
  platform: string;
  product_type_id: string;
  product_count: number;
  avg_loose: number;
  avg_cib: number;
  cib_to_loose_ratio: number;
  total_volume: number;
  avg_volume: number;
  pct_above_50: number;
  pct_above_100: number;
};

export default async function PlatformsPage() {
  // Read from cached platform_stats table
  let platforms: PlatformStat[] = [];
  try {
    platforms = sqlite
      .prepare(
        `SELECT * FROM platform_stats WHERE product_count >= 30 ORDER BY avg_volume DESC`,
      )
      .all() as PlatformStat[];
  } catch {
    // Table might not exist yet
  }

  const retro = platforms.filter((p) => p.product_type_id === "retro_game");
  const cards = platforms.filter((p) => p.product_type_id !== "retro_game");

  // Undervalued score: high volume + low price + high CIB ratio
  const maxVol = Math.max(...retro.map((p) => p.avg_volume), 1);
  const maxPrice = Math.max(...retro.map((p) => p.avg_loose), 1);
  const scored = retro.map((p) => ({
    ...p,
    score:
      (p.avg_volume / maxVol) * 0.4 +
      (1 - p.avg_loose / maxPrice) * 0.3 +
      Math.min((p.cib_to_loose_ratio || 0) / 5, 1) * 0.3,
  }));

  return (
    <div className="p-6 space-y-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Platform Analysis</h2>
        <p className="text-muted-foreground text-sm mt-0.5">
          Undervalued platforms — where the next price wave starts
        </p>
      </div>

      {/* Top undervalued */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Undervalued Platforms</CardTitle>
          <p className="text-xs text-muted-foreground">
            Scored by: 40% market activity + 30% low price + 30% CIB/loose ratio
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {scored
              .sort((a, b) => b.score - a.score)
              .slice(0, 6)
              .map((p) => (
                <Card key={p.platform} className="bg-muted/30">
                  <CardContent className="pt-4 space-y-2">
                    <div className="flex justify-between items-center">
                      <span className="font-semibold text-sm">{p.platform}</span>
                      <Badge variant={p.score > 0.6 ? "default" : "secondary"}>
                        {(p.score * 100).toFixed(0)}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <div>
                        <span className="text-muted-foreground">Avg loose</span>
                        <p className="font-mono">{fmt(p.avg_loose)}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Games</span>
                        <p className="font-mono">{p.product_count}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Volume</span>
                        <p className="font-mono">{Math.round(p.avg_volume)}/yr</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">&gt;$50</span>
                        <p className="font-mono">{p.pct_above_50.toFixed(0)}%</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              ))}
          </div>
        </CardContent>
      </Card>

      {/* Full table */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">All Retro Game Platforms</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Platform</TableHead>
                <TableHead className="text-xs text-right">Games</TableHead>
                <TableHead className="text-xs text-right">Avg Loose</TableHead>
                <TableHead className="text-xs text-right">Avg CIB</TableHead>
                <TableHead className="text-xs text-right">CIB/Loose</TableHead>
                <TableHead className="text-xs text-right">Avg Volume</TableHead>
                <TableHead className="text-xs text-right">&gt;$50</TableHead>
                <TableHead className="text-xs text-right">&gt;$100</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {retro.map((p) => (
                <TableRow key={p.platform}>
                  <TableCell className="text-sm font-medium">{p.platform}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{p.product_count}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{fmt(p.avg_loose)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {p.avg_cib ? fmt(p.avg_cib) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {p.cib_to_loose_ratio ? `${p.cib_to_loose_ratio.toFixed(1)}x` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {Math.round(p.avg_volume)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {p.pct_above_50.toFixed(0)}%
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {p.pct_above_100.toFixed(0)}%
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
