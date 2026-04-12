export const dynamic = "force-dynamic";

import { db } from "@/db/client";
import { opportunities } from "@/db/schema";
import { eq, count } from "drizzle-orm";

export async function GET() {
  const result = await db
    .select({ count: count() })
    .from(opportunities)
    .where(eq(opportunities.status, "new"));

  return Response.json({ new: result[0]?.count ?? 0 });
}
