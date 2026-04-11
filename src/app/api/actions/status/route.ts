export const dynamic = "force-dynamic";

import { running, lastRun } from "../route";

export async function GET() {
  return Response.json({ running, lastRun });
}
