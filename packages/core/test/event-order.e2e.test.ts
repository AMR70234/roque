/**
 * The event-order engine, end to end with the slow parts stubbed.
 *
 * Two properties matter more than the rest here, and both are about refusing to
 * act. An order whose condition nobody can source must be refused at arm time
 * rather than left resting forever; and a screen that fails because *our* side
 * broke must leave the order alone, because "we could not ask" and "the answer
 * is no" are different facts and only one of them is the order's fault.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  q: vi.fn(),
  adjudicate: vi.fn(),
  ethUsd: vi.fn(),
  preflightVaultSwap: vi.fn(),
  executeVaultSwap: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({ q: state.q }));
vi.mock("../src/genlayer.js", () => ({ adjudicate: state.adjudicate, interpret: vi.fn() }));
vi.mock("../src/services.js", () => ({
  preflightVaultSwap: state.preflightVaultSwap,
  executeVaultSwap: state.executeVaultSwap,
}));
vi.mock("../src/prices.js", () => ({
  ethUsd: state.ethUsd,
  tokenUsd: vi.fn(),
  toTriggerPrice: vi.fn(),
  usdValueRaw: vi.fn(),
}));

const { screenEventOrder, evaluateEventOrder } = await import("../src/events.js");

const user = "0x1111111111111111111111111111111111111111" as const;
const CHECKABLE = "the Federal Reserve cuts its benchmark interest rate";
const TX = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

// One Google News item, because the screen records which sources it sampled.
const RSS = `<rss><channel>
<item>
  <title>Fed cuts benchmark rate by 25 basis points</title>
  <link>https://example.com/fed</link>
  <pubDate>Fri, 02 Jan 2026 09:00:00 GMT</pubDate>
  <source url="https://reuters.com">Reuters</source>
</item>
</channel></rss>`;

type Row = Record<string, unknown> & { checks: number };

let row: Row;
let sqls: string[];

function baseRow(over: Record<string, unknown> = {}): Row {
  return {
    id: "ev-1",
    user_address: user,
    condition: CHECKABLE,
    token_in: "rUSDC",
    token_out: "rWETH",
    amount: "100",
    amount_is_percent: false,
    slippage_bps: 100,
    status: "screening",
    screen_verdict: null,
    screen_reason: null,
    screen_confidence: null,
    screen_sources: null,
    checks: 0,
    last_checked_at: null,
    verdict_met: null,
    verdict_confidence: null,
    verdict_rationale: null,
    evidence: null,
    expires_at: null,
    tx_hash: null,
    error: null,
    source_slug: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

const ran = (fragment: string) => sqls.some((s) => s.replace(/\s+/gu, " ").includes(fragment));

beforeEach(() => {
  vi.clearAllMocks();
  row = baseRow();
  sqls = [];

  // A tiny in-memory event_orders table: each UPDATE applies the fields it sets
  // to the one row, so assertions can read the persisted state afterwards.
  state.q.mockImplementation(async (text: string, params: unknown[] = []) => {
    sqls.push(text);
    const t = text.replace(/\s+/gu, " ").trim();

    if (t.startsWith("SELECT")) return [{ ...row }];

    if (t.includes("SET status='rejected'")) {
      Object.assign(row, {
        status: "rejected",
        screen_verdict: "unverifiable",
        screen_reason: params[1],
        screen_confidence: params[2],
        screen_sources: params[3] ? JSON.parse(String(params[3])) : null,
      });
      return [{ ...row }];
    }
    if (t.includes("SET status='armed', screen_verdict='verifiable'")) {
      Object.assign(row, {
        status: "armed",
        screen_verdict: "verifiable",
        screen_reason: params[1],
        screen_confidence: params[2],
        screen_sources: JSON.parse(String(params[3])),
        evidence: JSON.parse(String(params[4])),
        error: null,
      });
      return [{ ...row }];
    }
    if (t.includes("SET error=$2")) {
      Object.assign(row, { error: params[1] });
      return [];
    }
    if (t.includes("SET checks=checks+1")) {
      Object.assign(row, {
        checks: row.checks + 1,
        last_checked_at: new Date().toISOString(),
        evidence: JSON.parse(String(params[1])),
        verdict_met: params[2],
        verdict_confidence: params[3],
        verdict_rationale: params[4],
      });
      return [{ ...row }];
    }
    if (t.includes("SET status='expired'")) {
      Object.assign(row, { status: "expired" });
      return [{ ...row }];
    }
    if (t.includes("SET status='filled'")) {
      Object.assign(row, { status: "filled", tx_hash: params[1], error: null });
      return [{ ...row }];
    }
    if (t.includes("SET status=$3, error=$2")) {
      Object.assign(row, { status: params[2], error: params[1] });
      return [{ ...row }];
    }
    throw new Error(`Unhandled test query: ${t}`);
  });

  state.ethUsd.mockResolvedValue({ usd: 3_000 });
  state.preflightVaultSwap.mockResolvedValue({ amountInRaw: 1n, minOutRaw: 1n });
  state.executeVaultSwap.mockResolvedValue(TX);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, status: 200, text: async () => RSS })),
  );
});

describe("screenEventOrder", () => {
  it("refuses an unverifiable condition without paying for a consensus round", async () => {
    row = baseRow({ condition: "my landlord raises the rent on the flat" });

    const order = await screenEventOrder("ev-1");

    expect(order.status).toBe("rejected");
    expect(order.screenVerdict).toBe("unverifiable");
    expect(order.screenReason).toBe(
      "it turns on a private matter in your own life, not a public fact",
    );
    expect(order.screenConfidence).toBe("high");
    // The whole point of the local pass: no evidence gathered, no round paid for.
    expect(state.adjudicate).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("arms an order the validators agree is checkable, recording what it sampled", async () => {
    state.adjudicate.mockResolvedValue({
      met: true,
      confidence: "high",
      rationale: "central bank rate decisions are published and widely reported",
    });

    const order = await screenEventOrder("ev-1");

    expect(order.status).toBe("armed");
    expect(order.screenVerdict).toBe("verifiable");
    expect(order.screenConfidence).toBe("high");
    expect(order.screenSources).toEqual(["Reuters"]);
    expect(order.evidence?.items[0]?.title).toContain("Fed cuts benchmark rate");
    expect(order.error).toBeNull();

    // The screen asks the meta-question, not the condition itself.
    const [requestId, question] = state.adjudicate.mock.calls[0]!;
    expect(requestId).toBe("screen:ev-1");
    expect(question).toContain("VERIFIABILITY CHECK");
    expect(question).toContain(CHECKABLE);
  });

  it("rejects an order the validators cannot source, and says why", async () => {
    state.adjudicate.mockResolvedValue({
      met: false,
      confidence: "high",
      rationale: "no public source reports on this subject",
    });

    const order = await screenEventOrder("ev-1");

    expect(order.status).toBe("rejected");
    expect(order.screenVerdict).toBe("unverifiable");
    expect(order.screenReason).toBe("no public source reports on this subject");
    expect(order.screenSources).toEqual(["Reuters"]);
  });

  it("supplies its own words when the adjudicator offers no rationale", async () => {
    state.adjudicate.mockResolvedValue({ met: false, confidence: "medium", rationale: "" });

    const order = await screenEventOrder("ev-1");

    expect(order.screenReason).toBe("no public source could settle this condition");
  });

  it("leaves the order in screening when the consensus round itself fails", async () => {
    // A GenLayer outage is our problem, not the condition's. Rejecting here
    // would tell the user their perfectly checkable condition is unverifiable.
    state.adjudicate.mockRejectedValue(new Error("receipt poll timed out"));

    const order = await screenEventOrder("ev-1");

    expect(order.status).toBe("screening");
    expect(order.screenVerdict).toBeNull();
    expect(order.error).toBe("screening failed: receipt poll timed out");
    expect(ran("SET status='rejected'")).toBe(false);
  });

  it("does not re-screen an order that has already left screening", async () => {
    row = baseRow({ status: "armed", screen_verdict: "verifiable" });

    const order = await screenEventOrder("ev-1");

    expect(order.status).toBe("armed");
    expect(state.adjudicate).not.toHaveBeenCalled();
  });

  it("refuses to screen an order that does not exist", async () => {
    state.q.mockResolvedValueOnce([]);
    await expect(screenEventOrder("nope")).rejects.toThrow("No such event order.");
  });
});

describe("evaluateEventOrder", () => {
  const armed = (over: Record<string, unknown> = {}) =>
    baseRow({ status: "armed", screen_verdict: "verifiable", ...over });

  it("expires an order that ran out its clock, without asking anyone", async () => {
    row = armed({ expires_at: "2026-01-01T00:00:00.000Z" });

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("expired");
    expect(state.adjudicate).not.toHaveBeenCalled();
    expect(state.executeVaultSwap).not.toHaveBeenCalled();
  });

  it("fills on a confident verdict that the condition happened", async () => {
    row = armed();
    state.adjudicate.mockResolvedValue({
      met: true,
      confidence: "high",
      rationale: "the cut was announced and reported by several outlets",
    });

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("filled");
    expect(order.txHash).toBe(TX);
    expect(order.verdictMet).toBe(true);
    // The fill goes through the shared vault gate, so the user's on-chain caps
    // apply to a keeper-triggered trade exactly as to one they pressed.
    expect(state.preflightVaultSwap).toHaveBeenCalledWith(
      expect.objectContaining({ user, amount: "100", slippageBps: 100 }),
    );
    expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
  });

  it("does not move money on a met verdict the adjudicator is unsure about", async () => {
    // The adjudicator is told to lean sceptical, so low confidence on a "yes"
    // is the model saying it does not know.
    row = armed();
    state.adjudicate.mockResolvedValue({ met: true, confidence: "low", rationale: "unclear" });

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("armed");
    expect(order.verdictMet).toBe(false);
    expect(order.verdictConfidence).toBe("low");
    expect(state.executeVaultSwap).not.toHaveBeenCalled();
  });

  it("leaves the order resting when the condition has not happened", async () => {
    row = armed();
    state.adjudicate.mockResolvedValue({ met: false, confidence: "high", rationale: "no cut yet" });

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("armed");
    expect(order.verdictMet).toBe(false);
    expect(order.checks).toBe(1);
    expect(state.executeVaultSwap).not.toHaveBeenCalled();
  });

  it("retries a fill on an already-met verdict without paying for a second round", async () => {
    row = armed({ verdict_met: true, verdict_confidence: "high", checks: 1 });

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("filled");
    expect(state.adjudicate).not.toHaveBeenCalled();
    expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
  });

  it("stays armed after a transient chain error, so the next tick tries again", async () => {
    row = armed({ verdict_met: true, checks: 0 });
    state.executeVaultSwap.mockRejectedValue(new Error("fetch failed"));

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("armed");
    expect(order.error).toBe("fetch failed");
  });

  it("fails outright on a refusal the next attempt would earn again", async () => {
    row = armed({ verdict_met: true, checks: 0 });
    state.executeVaultSwap.mockRejectedValue(
      new Error("This trade ($600.00) exceeds your per-trade limit of $500.00."),
    );

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("failed");
    expect(order.error).toContain("exceeds your per-trade limit");
  });

  it("gives up once the fill attempts are spent, so a broken order cannot burn gas forever", async () => {
    row = armed({ verdict_met: true, checks: 2 });
    state.executeVaultSwap.mockRejectedValue(new Error("fetch failed"));

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("failed");
  });

  it("does nothing to an order that is not armed", async () => {
    row = baseRow({ status: "cancelled" });

    const order = await evaluateEventOrder("ev-1");

    expect(order.status).toBe("cancelled");
    expect(state.adjudicate).not.toHaveBeenCalled();
  });
});
