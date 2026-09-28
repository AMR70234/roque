import { handleReadShare } from "@roque/core/api";
import { run } from "../../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The one open route in this family. A forkable link that only its author can
 * open is not a link, so reading a share needs no session; publishing and forking
 * do, because both act on somebody's own account.
 *
 * Slugs always carry a random suffix, so none can ever be the literal `recent`,
 * `mine` or `fork` that sit beside this segment.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  return run(() => handleReadShare(slug));
}
