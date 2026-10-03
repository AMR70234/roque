import { handleArmPlaybook } from "@roque/core/api";
import { run, body, bearerToken } from "../../_util";

export const runtime = "nodejs";
// Arming screens every event trigger in the playbook, so this inherits the
// screen's cost once per such step, and then writes the on-chain holds and
// waits for them. A round measures 23-68s, so a plan with two event steps was
// never going to fit in 60 and was being killed partway through.
export const maxDuration = 300;

export async function POST(req: Request) {
  return run(async () => handleArmPlaybook(await body(req), bearerToken(req)));
}
