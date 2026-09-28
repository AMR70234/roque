import { handleArmPlaybook } from "@roque/core/api";
import { run, body, bearerToken } from "../../_util";

export const runtime = "nodejs";
// Arming screens every event trigger in the playbook, so this inherits the
// screen's cost once per such step.
export const maxDuration = 60;

export async function POST(req: Request) {
  return run(async () => handleArmPlaybook(await body(req), bearerToken(req)));
}
