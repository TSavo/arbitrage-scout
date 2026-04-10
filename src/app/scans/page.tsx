export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import { scanLogs, marketplaces } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ScanButtons } from "./ScansClient";

function duration(start: string, end: string | null) {
  if (!end) return "running…";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function timeAgo(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default async function ScansPage() {
  const scans = await db
    .select({
      id: scanLogs.id,
      startedAt: scanLogs.startedAt,
      finishedAt: scanLogs.finishedAt,
      marketplaceId: scanLogs.marketplaceId,
      queriesRun: scanLogs.queriesRun,
      listingsFound: scanLogs.listingsFound,
      opportunitiesFound: scanLogs.opportunitiesFound,
      rateLimited: scanLogs.rateLimited,
      error: scanLogs.error,
    })
    .from(scanLogs)
    .orderBy(desc(scanLogs.startedAt))
    .limit(100);

  return (
    <div className="p-6 space-y-4">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Scans</h2>
          <p className="text-muted-foreground text-sm mt-0.5">
            Scan history and controls
          </p>
        </div>
        <ScanButtons />
      </div>

      <div className="rounded-md border border-border overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30 hover:bg-muted/30">
              <TableHead className="text-xs">ID</TableHead>
              <TableHead className="text-xs">Started</TableHead>
              <TableHead className="text-xs">Duration</TableHead>
              <TableHead className="text-xs">Marketplace</TableHead>
              <TableHead className="text-xs text-right">Queries</TableHead>
              <TableHead className="text-xs text-right">Listings</TableHead>
              <TableHead className="text-xs text-right">Opps</TableHead>
              <TableHead className="text-xs">Rate Ltd</TableHead>
              <TableHead className="text-xs">Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {scans.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={9}
                  className="text-center text-muted-foreground py-10 text-sm"
                >
                  No scans yet. Use the buttons above to trigger one.
                </TableCell>
              </TableRow>
            )}
            {scans.map((scan) => (
              <TableRow key={scan.id} className="hover:bg-accent/20 transition-colors">
                <TableCell className="font-mono text-xs text-muted-foreground">
                  #{scan.id}
                </TableCell>
                <TableCell className="text-xs whitespace-nowrap">
                  {timeAgo(scan.startedAt)}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {duration(scan.startedAt, scan.finishedAt)}
                </TableCell>
                <TableCell>
                  {scan.marketplaceId ? (
                    <Badge variant="outline" className="text-xs">
                      {scan.marketplaceId}
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground text-xs">all</span>
                  )}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {scan.queriesRun}
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {scan.listingsFound}
                </TableCell>
                <TableCell className="text-right font-mono text-sm font-semibold text-green-400">
                  {scan.opportunitiesFound}
                </TableCell>
                <TableCell>
                  {scan.rateLimited ? (
                    <Badge variant="destructive" className="text-xs">
                      yes
                    </Badge>
                  ) : (
                    <span className="text-muted-foreground text-xs">no</span>
                  )}
                </TableCell>
                <TableCell>
                  {scan.error ? (
                    <Badge variant="destructive" className="text-xs" title={scan.error}>
                      error
                    </Badge>
                  ) : scan.finishedAt ? (
                    <Badge variant="secondary" className="text-xs">
                      done
                    </Badge>
                  ) : (
                    <Badge variant="default" className="text-xs">
                      running
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
