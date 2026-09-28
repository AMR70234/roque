import { handleMyShares } from "@roque/core/api";
import { run, bearerToken } from "../../../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ user: string }> }) {
  const { user } = await ctx.params;
  return run(() => handleMyShares(user, bearerToken(req)));
}
