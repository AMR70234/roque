import { handleJudgmentTick } from "@roque/core/api";
import { serverEnv } from "@roque/core/env";
import { run } from "../../_util";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Screening, adjudicating and advancing all lean on GenLayer consensus, so this
// is the longest-running route we have. The per-tick budgets in events.ts and
// playbooks.ts exist to keep it inside this ceiling.
//
// 60 was not a ceiling those budgets could ever fit inside. EVENT_TICK_BUDGET
// is three rows and a round measures 23-68s, so a full pass needs minutes and
// the platform was killing this one partway through its first or second row,
// every time it ran. 300 is the Hobby maximum.
export const maxDuration = 300;

/**
 * The judgment tick: screen new event orders, ask the validators whether armed
 * conditions have come true, walk playbooks to their next step, and refile the
 * proposals inbox. Guarded by the same shared secret as the keeper, so only the
 * scheduler can nudge it.
 *
 * The standalone relayer runs the same work on a much shorter timer. This route
 * is the backstop for deployments where only the web app is running.
 */
function authorized(req: Request): boolean {
  const secret = serverEnv().cronSecret;
  const header = req.headers.get("authorization");
  return header === `Bearer ${secret}` || req.headers.get("x-cron-secret") === secret;
}

export async function GET(req: Request) {
  if (!authorized(req)) {
    return new Response(JSON.stringify({ error: "Not your keeper to wake." }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  return run(() => handleJudgmentTick());
}

export const POST = GET;
