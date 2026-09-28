import { handleRecentShares } from "@roque/core/api";
import { run } from "../../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return run(() => handleRecentShares());
}
