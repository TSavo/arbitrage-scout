export const dynamic = "force-dynamic";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { profilePlatforms, type PlatformProfile } from "@/scanner/platforms";

function fmt(n: number) {
  return `$${n.toFixed(0)}`;
}

function shortPath(path: string): string {
  const segs = path.split("/").filter(Boolean);
  return segs[segs.length - 1] ?? path;
}

export default async function PlatformsPage() {
  let platforms: PlatformProfile[] = [];
  try {
    platforms = profilePlatforms({ minProducts: 30 });
  } catch {
    // Tables might not exist yet
  }

  const retro = platforms.filter((p) =>
    p.taxonomyPath.startsWith("/electronics/video_games"),
  );
  const cards = platforms.filter(
    (p) => !p.taxonomyPath.startsWith("/electronics/video_games"),
  );
  void cards;

  // Undervalued score: high volume + low price + high CIB ratio
  const maxVol = Math.max(...retro.map((p) => p.avgVolume), 1);
  const maxPrice = Math.max(...retro.map((p) => p.avgLoose), 1);
  const scored = retro.map((p) => ({
    ...p,
    score:
      (p.avgVolume / maxVol) * 0.4 +
      (1 - p.avgLoose / maxPrice) * 0.3 +
      Math.min((p.cibToLooseRatio || 0) / 5, 1) * 0.3,
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
                    <div className="text-[10px] text-muted-foreground">
                      {shortPath(p.taxonomyPath)}
                    </div>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <div>
                        <span className="text-muted-foreground">Avg loose</span>
                        <p className="font-mono">{fmt(p.avgLoose)}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Games</span>
                        <p className="font-mono">{p.productCount}</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">Volume</span>
                        <p className="font-mono">{Math.round(p.avgVolume)}/yr</p>
                      </div>
                      <div>
                        <span className="text-muted-foreground">&gt;$50</span>
                        <p className="font-mono">{p.pctAbove50.toFixed(0)}%</p>
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
                <TableHead className="text-xs">Taxonomy</TableHead>
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
                  <TableCell className="text-xs text-muted-foreground">
                    {shortPath(p.taxonomyPath)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">{p.productCount}</TableCell>
                  <TableCell className="text-right font-mono text-sm">{fmt(p.avgLoose)}</TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {p.avgCib ? fmt(p.avgCib) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {p.cibToLooseRatio ? `${p.cibToLooseRatio.toFixed(1)}x` : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {Math.round(p.avgVolume)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {p.pctAbove50.toFixed(0)}%
                  </TableCell>
                  <TableCell className="text-right font-mono text-sm">
                    {p.pctAbove100.toFixed(0)}%
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
