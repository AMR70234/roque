import { handleForkShare } from "@roque/core/api";
import { run, body, bearerToken } from "../../_util";

export const runtime = "nodejs";

/**
 * A fork lands unarmed on purpose: the thesis copies across, the decision to put
 * money behind it stays with whoever forked it. No screening happens here, so
 * this route is quick.
 */
export async function POST(req: Request) {
  return run(async () => handleForkShare(await body(req), bearerToken(req)));
}
