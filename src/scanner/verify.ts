/**
 * Verify that opportunity listing URLs still point to the right item.
 * HiBid recycles lot IDs — a URL that was a GameCube yesterday is beads today.
 *
 * Fetches each URL, checks if the page title matches what we stored.
 * Marks stale opportunities with a "stale_url" flag.
 */

import { db } from "@/db/client";
import { opportunities, listings } from "@/db/schema";
import { eq, and, notInArray } from "drizzle-orm";
import { log, section, progress } from "@/lib/logger";
import { cachedFetch } from "@/lib/cached_fetch";

export interface VerifyResult {
  checked: number;
  valid: number;
  stale: number;
  errors: number;
}

/**
 * Verify active opportunity URLs are still pointing to the right listings.
 * Fetches the page title from each URL and compares to stored title.
 * Marks mismatches with "stale_url" flag and sets status to "passed".
 */
export async function verifyOpportunityUrls(opts: {
  marketplaceId?: string;
  limit?: number;
} = {}): Promise<VerifyResult> {
  section("VERIFY OPPORTUNITY URLS");

  // Get active opportunities with URLs
  const opps = await db
    .select({
      oppId: opportunities.id,
      listingId: opportunities.listingId,
      flags: opportunities.flags,
      status: opportunities.status,
      listingTitle: listings.title,
      url: listings.url,
      marketplaceId: listings.marketplaceId,
    })
    .from(opportunities)
    .innerJoin(listings, eq(opportunities.listingId, listings.id))
    .where(
      and(
        eq(opportunities.status, "new"),
        ...(opts.marketplaceId ? [eq(listings.marketplaceId, opts.marketplaceId)] : []),
      ),
    )
    .limit(opts.limit ?? 100);

  const toCheck = opps.filter((o) => o.url);
  log("verify", `${toCheck.length} opportunities to verify`);

  let valid = 0;
  let stale = 0;
  let errors = 0;

  for (let i = 0; i < toCheck.length; i++) {
    const opp = toCheck[i];
    progress(i + 1, toCheck.length, "URLs verified");

    try {
      const resp = await cachedFetch(
        opp.url!,
        {
          redirect: "follow",
          headers: { "User-Agent": "Mozilla/5.0" },
          signal: AbortSignal.timeout(10000),
        },
        { ttlMs: 10 * 60 * 1000, cacheTag: "verify-url" },
      );

      if (!resp.ok) {
        // 404 or error — listing is gone
        log("verify", `STALE (${resp.status}): ${opp.url}`);
        await markStale(opp.oppId, opp.flags as string[]);
        stale++;
        continue;
      }

      const html = resp.text();
      // Extract page title
      const titleMatch = html.match(/<title[^>]*>([^<]+)</i);
      const pageTitle = titleMatch?.[1]?.trim() ?? "";

      // Check if the page title still relates to what we stored
      // HiBid page titles are like "ItemName | Live and Online Auctions on HiBid.com"
      const pageName = pageTitle.split("|")[0]?.trim().toLowerCase() ?? "";
      const storedName = opp.listingTitle.toLowerCase();

      // Simple check: do the first few significant words overlap?
      const pageWords = pageName.split(/\s+/).filter((w) => w.length > 2);
      const storedWords = storedName.split(/\s+/).filter((w) => w.length > 2);
      const overlap = pageWords.filter((w) => storedWords.some((sw) => sw.includes(w) || w.includes(sw)));

      if (overlap.length === 0 && pageWords.length > 0) {
        log("verify", `STALE (title mismatch): stored="${opp.listingTitle}" page="${pageName}" url=${opp.url}`);
        await markStale(opp.oppId, opp.flags as string[]);
        stale++;
      } else {
        valid++;
      }
    } catch {
      errors++;
    }

    // Rate limit — don't hammer the sites
    await new Promise((r) => setTimeout(r, 500));
  }

  section("VERIFY COMPLETE");
  log("verify", `checked: ${toCheck.length} | valid: ${valid} | stale: ${stale} | errors: ${errors}`);

  return { checked: toCheck.length, valid, stale, errors };
}

async function markStale(oppId: number, existingFlags: string[]): Promise<void> {
  const flags = [...existingFlags];
  if (!flags.includes("stale_url")) flags.push("stale_url");

  await db.update(opportunities)
    .set({ flags, status: "passed" })
    .where(eq(opportunities.id, oppId));
}
