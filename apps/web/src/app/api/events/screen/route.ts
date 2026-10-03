import { handleScreenEventOrder } from "@roque/core/api";
import { run, body, bearerToken } from "../../_util";

export const runtime = "nodejs";
// A verifiability screen is a full GenLayer consensus round: a write, then a
// receipt poll while every validator forms its own view.
//
// This said 24-36s and was capped at 60 on that basis. Measured again on
// 2026-10-02 against studionet, five rounds came in at 23s, 44s, 46s, 57s and
// 68s. So the old ceiling sat below the slow half of the distribution and the
// platform was killing the function mid-round, which is what produced the
// "that took longer than the server would wait" message people were seeing.
//
// 300 is the Hobby maximum and also its default, so the 60 was not a platform
// limit, it was us asking for less. Nothing waits the full budget: the function
// returns the moment consensus lands.
export const maxDuration = 300;

export async function POST(req: Request) {
  return run(async () => handleScreenEventOrder(await body(req), bearerToken(req)));
}
