import { handleRefreshProposals } from "@roque/core/api";
import { run, body, bearerToken } from "../../_util";

export const runtime = "nodejs";
// Reads a vault, a capability, every open order and a day of price history
// before it decides what is worth raising.
export const maxDuration = 60;

export async function POST(req: Request) {
  return run(async () => handleRefreshProposals(await body(req), bearerToken(req)));
}
