import { handlePlaybook } from "@roque/core/api";
import { run, bearerToken } from "../../../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  return run(() => handlePlaybook(id, bearerToken(req)));
}
