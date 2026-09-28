/**
 * The playbook engine: one step considered per call, in order, once.
 *
 * The ordering guarantee is the whole product here — a ladder whose second rung
 * fires before its first is not a plan, it is two random trades. That guarantee
 * rests on the cursor-guarded claim, so the case where a second runner finds
 * nothing to claim is tested as carefully as the happy path. The other rule
 * worth pinning down is that a step never fires on a verdict the adjudicator
 * itself is unsure about.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybookStep } from "../src/playbooks.js";

const state = vi.hoisted(() => ({
  q: vi.fn(),
  adjudicate: vi.fn(),
  ethUsd: vi.fn(),
  gatherEvidence: vi.fn(),
  preflightVaultSwap: vi.fn(),
  executeVaultSwap: vi.fn(),
  vaultBalance: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({ q: state.q }));
// The only chain read on this path is the funding gate arming does. It reads a
// balance we choose, so the real gate runs rather than being mocked away.
vi.mock("../src/intents.js", () => ({ vaultBalance: state.vaultBalance }));
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
// Evidence gathering is the network half of an event step; the judgment half is
// adjudicate. Both are stubbed, and the real interval is kept so the rationing
// rule behaves as it does in production.
vi.mock("../src/events.js", () => ({
  gatherEvidence: state.gatherEvidence,
  localScreen: vi.fn(() => null),
  EVENT_CHECK_INTERVAL_MS: 10 * 60 * 1000,
}));

const { advancePlaybook, armPlaybook, normaliseStep } = await import("../src/playbooks.js");

const user = "0x1111111111111111111111111111111111111111" as const;
const TX = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CONDITION = "the Federal Reserve cuts its benchmark interest rate";

type Row = Record<string, unknown> & { steps: PlaybookStep[]; step_cursor: number };

let row: Row;
let sqls: string[];
let claimResult: Array<{ id: string }>;

function mkStep(trigger: unknown, amount = "25"): PlaybookStep {
  return normaliseStep(
    { trigger, action: { tokenIn: "rUSDC", tokenOut: "rWETH", amount, amountIsPercent: true } },
    0,
  );
}

function baseRow(steps: PlaybookStep[], over: Record<string, unknown> = {}): Row {
  return {
    id: "pb-1",
    user_address: user,
    name: "Ladder into the dip",
    note: null,
    status: "armed",
    steps,
    step_cursor: 0,
    slippage_bps: 100,
    last_checked_at: null,
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
  sqls = [];
  claimResult = [{ id: "pb-1" }];
  row = baseRow([mkStep({ kind: "immediate" })]);

  state.q.mockImplementation(async (text: string, params: unknown[] = []) => {
    sqls.push(text);
    const t = text.replace(/\s+/gu, " ").trim();

    if (t.startsWith("SELECT * FROM playbooks")) return [{ ...row }];
    if (t.startsWith("INSERT INTO playbook_events")) return [];

    // The claim is checked before the plain check-counter update, because the
    // two share a prefix and only the claim carries the 'waiting' guard.
    if (t.includes("(steps->$3->>'status') = 'waiting' RETURNING id")) {
      row.steps = JSON.parse(String(params[1])) as PlaybookStep[];
      return claimResult;
    }
    if (t.includes("SET steps=$2::jsonb, last_checked_at=now()")) {
      row.steps = JSON.parse(String(params[1])) as PlaybookStep[];
      row.last_checked_at = new Date().toISOString();
      return [];
    }
    if (t.includes("status='failed', error=$3")) {
      Object.assign(row, {
        steps: JSON.parse(String(params[1])) as PlaybookStep[],
        status: "failed",
        error: params[2],
      });
      return [{ ...row }];
    }
    if (t.includes("SET steps=$2::jsonb, step_cursor=$3")) {
      Object.assign(row, {
        steps: JSON.parse(String(params[1])) as PlaybookStep[],
        step_cursor: params[2],
      });
      return [{ ...row }];
    }
    if (t.includes("SET status='completed'")) {
      Object.assign(row, {
        status: "completed",
        steps: JSON.parse(String(params[1])) as PlaybookStep[],
      });
      return [{ ...row }];
    }
    if (t.includes("SET status='armed'")) {
      Object.assign(row, {
        status: "armed",
        steps: JSON.parse(String(params[1])) as PlaybookStep[],
        step_cursor: 0,
        error: null,
      });
      return [{ ...row }];
    }
    if (t.includes("SET steps=$2::jsonb, error=$3")) {
      Object.assign(row, {
        steps: JSON.parse(String(params[1])) as PlaybookStep[],
        error: params[2],
      });
      return [{ ...row }];
    }
    throw new Error(`Unhandled test query: ${t}`);
  });

  state.ethUsd.mockResolvedValue({ usd: 3_000 });
  state.gatherEvidence.mockResolvedValue({
    query: "federal reserve cuts benchmark interest rate",
    fetchedAt: "2026-01-02T12:00:00.000Z",
    items: [{ source: "Reuters", title: "Fed cuts by 25bp", published: null, url: null }],
    market: { ethUsd: 3_000 },
    notes: [],
  });
  state.preflightVaultSwap.mockResolvedValue({ amountInRaw: 1n, minOutRaw: 1n });
  state.executeVaultSwap.mockResolvedValue(TX);
  state.vaultBalance.mockResolvedValue(10_000_000_000n); // 10,000 rUSDC
});

// ─────────────────────────────────────────────────────────────
// Arming is the signature, so arming is where the vault is checked
// ─────────────────────────────────────────────────────────────

describe("armPlaybook", () => {
  const absolute = (amount: string) =>
    normaliseStep(
      { trigger: { kind: "immediate" }, action: { tokenIn: "rUSDC", tokenOut: "rWETH", amount, amountIsPercent: false } },
      0,
    );

  beforeEach(() => {
    row = baseRow([absolute("100")], { status: "draft" });
  });

  it("arms a plan the vault can pay for", async () => {
    const pb = await armPlaybook("pb-1", user);

    expect(pb.status).toBe("armed");
    expect(pb.steps[0]!.armedAt).not.toBeNull();
    expect(state.vaultBalance).toHaveBeenCalledTimes(1);
  });

  it("refuses to arm a plan the vault cannot pay for, and names the step", async () => {
    state.vaultBalance.mockResolvedValue(40_000_000n); // 40 rUSDC

    await expect(armPlaybook("pb-1", user)).rejects.toThrow(
      "Step 1 needs 100 rUSDC and your vault holds 40.",
    );
    // Still a draft: nothing is half-armed, and the person can resize or fund it.
    expect(row.status).toBe("draft");
  });

  it("adds the rungs up rather than checking each on its own", async () => {
    // 100 + 100 against a 150 balance: each rung passes alone, the plan does not.
    row = baseRow([absolute("100"), absolute("100")], { status: "draft" });
    state.vaultBalance.mockResolvedValue(150_000_000n);

    await expect(armPlaybook("pb-1", user)).rejects.toThrow(
      "Step 1 and Step 2 needs 200 rUSDC and your vault holds 150.",
    );
  });

  it("does not make a ladder pre-hold what its first rung buys", async () => {
    // Buy rWETH with rUSDC, then sell that rWETH. The vault holds no rWETH and
    // should not have to: refusing this would refuse the headline use case.
    row = baseRow(
      [
        absolute("100"),
        normaliseStep(
          {
            trigger: { kind: "immediate" },
            action: { tokenIn: "rWETH", tokenOut: "rUSDC", amount: "1", amountIsPercent: false },
          },
          1,
        ),
      ],
      { status: "draft" },
    );
    state.vaultBalance.mockResolvedValue(200_000_000n);

    const pb = await armPlaybook("pb-1", user);

    expect(pb.status).toBe("armed");
    // One read, for rUSDC only. A second read would mean rWETH was being asked for.
    expect(state.vaultBalance).toHaveBeenCalledTimes(1);
  });

  it("checks the money before paying for a consensus round", async () => {
    // Screening an event step costs half a minute of validator time. A plan the
    // vault cannot fund never gets that far.
    row = baseRow([absolute("100"), mkStep({ kind: "event", condition: CONDITION })], {
      status: "draft",
    });
    state.vaultBalance.mockResolvedValue(10_000_000n); // 10 rUSDC

    await expect(armPlaybook("pb-1", user)).rejects.toThrow("your vault holds 10");
    expect(state.adjudicate).not.toHaveBeenCalled();
    expect(state.gatherEvidence).not.toHaveBeenCalled();
  });

  it("refuses a percentage rung when the vault is empty", async () => {
    row = baseRow([mkStep({ kind: "immediate" })], { status: "draft" });
    state.vaultBalance.mockResolvedValue(0n);

    await expect(armPlaybook("pb-1", user)).rejects.toThrow(
      "Step 1 spends a share of your rUSDC, and your vault holds none.",
    );
  });
});

describe("advancePlaybook", () => {
  it("fires a single immediate step and completes the playbook", async () => {
    const pb = await advancePlaybook("pb-1");

    expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
    expect(pb.status).toBe("completed");
    expect(pb.steps[0]!.status).toBe("done");
    expect(pb.steps[0]!.txHash).toBe(TX);
    expect(pb.steps[0]!.firedAt).not.toBeNull();
    // The fill goes through the shared vault gate with the playbook's slippage.
    expect(state.preflightVaultSwap).toHaveBeenCalledWith(
      expect.objectContaining({ user, amount: "25", amountIsPercent: true, slippageBps: 100 }),
    );
  });

  it("hands the clock to the next step so a delay measures from this fill", async () => {
    row = baseRow([mkStep({ kind: "immediate" }), mkStep({ kind: "delay", minutes: 10 })]);

    const pb = await advancePlaybook("pb-1");

    expect(pb.status).toBe("armed");
    expect(pb.stepCursor).toBe(1);
    expect(pb.steps[0]!.status).toBe("done");
    expect(pb.steps[1]!.status).toBe("waiting");
    // Null here would mean the delay never starts counting.
    expect(pb.steps[1]!.armedAt).not.toBeNull();
  });

  it("considers exactly one step per call", async () => {
    row = baseRow([mkStep({ kind: "immediate" }), mkStep({ kind: "immediate" })]);

    await advancePlaybook("pb-1");

    expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
  });

  it("records a check and trades nothing when a price trigger has not been reached", async () => {
    row = baseRow([mkStep({ kind: "price", direction: "above", usd: 5_000 })]);

    const pb = await advancePlaybook("pb-1");

    expect(state.executeVaultSwap).not.toHaveBeenCalled();
    expect(pb.steps[0]!.status).toBe("waiting");
    expect(pb.steps[0]!.checks).toBe(1);
    expect(pb.steps[0]!.lastCheckedAt).not.toBeNull();
    expect(ran("RETURNING id")).toBe(false);
  });

  it("fires once the price trigger is reached", async () => {
    row = baseRow([mkStep({ kind: "price", direction: "below", usd: 3_000 })]);

    const pb = await advancePlaybook("pb-1");

    expect(pb.steps[0]!.status).toBe("done");
    expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
  });

  it("asks GenLayer about an event step and records the verdict", async () => {
    row = baseRow([mkStep({ kind: "event", condition: CONDITION })]);
    state.adjudicate.mockResolvedValue({
      met: true,
      confidence: "high",
      rationale: "widely reported",
    });

    const pb = await advancePlaybook("pb-1");

    expect(state.gatherEvidence).toHaveBeenCalledWith(CONDITION);
    expect(state.adjudicate).toHaveBeenCalledTimes(1);
    expect(pb.steps[0]!.verdict).toEqual({
      met: true,
      confidence: "high",
      rationale: "widely reported",
    });
    expect(pb.steps[0]!.status).toBe("done");
  });

  it("does not fire an event step on a verdict the adjudicator is unsure about", async () => {
    row = baseRow([mkStep({ kind: "event", condition: CONDITION })]);
    state.adjudicate.mockResolvedValue({ met: true, confidence: "low", rationale: "unclear" });

    const pb = await advancePlaybook("pb-1");

    expect(state.executeVaultSwap).not.toHaveBeenCalled();
    expect(pb.steps[0]!.status).toBe("waiting");
    // The verdict is still written down, so the reason is visible in the UI.
    expect(pb.steps[0]!.verdict).toEqual({ met: true, confidence: "low", rationale: "unclear" });
  });

  it("bails without trading when another runner already claimed the step", async () => {
    // Two keepers, one step. The cursor-and-status guard means the loser's
    // UPDATE matches nothing, and it must not go on to trade anyway.
    claimResult = [];

    const pb = await advancePlaybook("pb-1");

    expect(state.preflightVaultSwap).not.toHaveBeenCalled();
    expect(state.executeVaultSwap).not.toHaveBeenCalled();
    expect(pb.status).toBe("armed");
    expect(pb.stepCursor).toBe(0);
  });

  it("stops the whole playbook when a step's fill fails", async () => {
    // A ladder whose first rung did not fill must not go on to its second: the
    // later steps were sized and priced on the assumption the earlier ones ran.
    row = baseRow([mkStep({ kind: "immediate" }), mkStep({ kind: "immediate" })]);
    state.executeVaultSwap.mockRejectedValue(new Error("vault balance is too low"));

    const pb = await advancePlaybook("pb-1");

    expect(pb.status).toBe("failed");
    expect(pb.error).toBe("vault balance is too low");
    expect(pb.steps[0]!.status).toBe("failed");
    expect(pb.steps[0]!.error).toBe("vault balance is too low");
    expect(pb.stepCursor).toBe(0);
    expect(state.executeVaultSwap).toHaveBeenCalledTimes(1);
  });

  it("rations an event step rather than checking it every tick", async () => {
    // Each event check is a consensus round. A step checked a moment ago is not
    // due, and the call must cost nothing at all.
    const step = mkStep({ kind: "event", condition: CONDITION });
    row = baseRow([{ ...step, lastCheckedAt: new Date().toISOString() }]);

    await advancePlaybook("pb-1");

    expect(state.gatherEvidence).not.toHaveBeenCalled();
    expect(state.adjudicate).not.toHaveBeenCalled();
    expect(sqls).toHaveLength(1);
  });

  it("completes a playbook whose cursor has run past the last step", async () => {
    row = baseRow([mkStep({ kind: "immediate" })], { step_cursor: 1 });

    const pb = await advancePlaybook("pb-1");

    expect(pb.status).toBe("completed");
    expect(state.executeVaultSwap).not.toHaveBeenCalled();
  });

  it("leaves a playbook alone unless it is armed", async () => {
    for (const status of ["draft", "cancelled", "completed", "failed"]) {
      vi.clearAllMocks();
      row = baseRow([mkStep({ kind: "immediate" })], { status });

      const pb = await advancePlaybook("pb-1");

      expect(pb.status).toBe(status);
      expect(state.executeVaultSwap).not.toHaveBeenCalled();
    }
  });

  it("refuses to advance a playbook that does not exist", async () => {
    state.q.mockResolvedValueOnce([]);
    await expect(advancePlaybook("nope")).rejects.toThrow("No such playbook.");
  });
});
