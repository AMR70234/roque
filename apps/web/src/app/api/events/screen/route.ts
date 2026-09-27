import { handleScreenEventOrder } from "@roque/core/api";
import { run, body, bearerToken } from "../../_util";

export const runtime = "nodejs";
// A verifiability screen is a full GenLayer consensus round: a write, then a
// receipt poll while every validator forms its own view. Measured at 24-36s, so
// this route needs the long ceiling. It is why screening is its own call and not
// folded into creating the order.
export const maxDuration = 60;

export async function POST(req: Request) {
  return run(async () => handleScreenEventOrder(await body(req), bearerToken(req)));
}
