/**
 * Vault reservations: money already promised, and what that forbids.
 *
 * The property under test is the one the ledger exists for, and it is easiest to
 * state as the bug it replaces. A vault holding 100 rUSDC used to let a person
 * write two event orders that each spent 100, because each order checked the
 * balance on its own and the balance had not moved yet. One of those two orders
 * was always going to fail, days later, on money the other one took.
 *
 * So most of these assert an absence: no second order, no second claim, no hold
 * left standing on something that can no longer trade. The releases matter as
 * much as the holds — a claim that outlives its order is money locked up for
 * nothing, which is the same bug pointing the other way.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { reservationStore } from "./helpers/reservations.js";

const state = vi.hoisted(() => ({
  q: vi.fn(),
  vaultBalance: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({ q: state.q }));
vi.mock("../src/intents.js", () => ({ vaultBalance: state.vaultBalance }));

const { reserve, release, heldByToken, availability, assertWithdrawable } = await import(
  "../src/reservations.js"
);
const { assertVaultFunds } = await import("../src/funding.js");

const user = "0x1111111111111111111111111111111111111111" as const;
const other = "0x2222222222222222222222222222222222222222" as const;

/** rUSDC carries six decimals, so a whole token is a million base units. */
const USDC = (n: number) => BigInt(n) * 1_000_000n;

let held: ReturnType<typeof reservationStore>;

beforeEach(() => {
  vi.clearAllMocks();
  held = reservationStore();
  state.q.mockImplementation(async (text: string, params: unknown[] = []) => {
    const handled = held.handle(text, params);
    if (handled !== null) return handled;
    throw new Error(`Unhandled test query: ${text.replace(/\s+/gu, " ").trim()}`);
  });
});

describe("reserve", () => {
  it("holds the exact amount in the token's own base units", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "250.5", source: "event_order", sourceId: "eo-1" },
    ]);
    const map = await heldByToken(user);
    expect(map.get("rUSDC")?.raw).toBe(250_500_000n);
    expect(map.get("rUSDC")?.claims).toBe(1);
  });

  it("adds a second claim to the first rather than replacing it", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
    ]);
    await reserve([
      { user, token: "rUSDC", amount: "40", source: "event_order", sourceId: "eo-2" },
    ]);
    const map = await heldByToken(user);
    expect(map.get("rUSDC")?.raw).toBe(USDC(140));
    expect(map.get("rUSDC")?.claims).toBe(2);
  });

  it("is idempotent per rung, so arming twice claims the money once", async () => {
    const leg = {
      user,
      token: "rUSDC",
      amount: "100",
      source: "playbook" as const,
      sourceId: "pb-1",
      stepIndex: 0,
    };
    await reserve([leg]);
    await reserve([leg]);
    const map = await heldByToken(user);
    expect(map.get("rUSDC")?.raw).toBe(USDC(100));
    expect(held.held()).toHaveLength(1);
  });

  it("treats the rungs of one ladder as separate claims", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "playbook", sourceId: "pb-1", stepIndex: 0 },
      { user, token: "rUSDC", amount: "60", source: "playbook", sourceId: "pb-1", stepIndex: 1 },
    ]);
    expect((await heldByToken(user)).get("rUSDC")?.raw).toBe(USDC(160));
  });

  it("records a percentage as a share and reserves no figure for it", async () => {
    // A percent order is sized at fire time against whatever is there, so there
    // is no number to hold. Recording the share keeps it visible without
    // inventing an amount the order never committed to.
    await reserve([
      {
        user,
        token: "rUSDC",
        amount: "40",
        amountIsPercent: true,
        source: "event_order",
        sourceId: "eo-1",
      },
    ]);
    const hold = (await heldByToken(user)).get("rUSDC");
    expect(hold?.raw).toBe(0n);
    expect(hold?.percents).toEqual([40]);
  });

  it("keeps one person's claims out of another's", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
    ]);
    expect((await heldByToken(other)).size).toBe(0);
  });
});

describe("release", () => {
  it("stops a claim counting once its order is called off", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
    ]);
    await release("event_order", "eo-1");
    expect((await heldByToken(user)).size).toBe(0);
  });

  it("frees one rung without freeing the rest of the ladder", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "playbook", sourceId: "pb-1", stepIndex: 0 },
      { user, token: "rUSDC", amount: "60", source: "playbook", sourceId: "pb-1", stepIndex: 1 },
    ]);
    await release("playbook", "pb-1", "spent", 0);
    expect((await heldByToken(user)).get("rUSDC")?.raw).toBe(USDC(60));
  });

  it("frees every rung when the whole plan stops", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "playbook", sourceId: "pb-1", stepIndex: 0 },
      { user, token: "rUSDC", amount: "60", source: "playbook", sourceId: "pb-1", stepIndex: 1 },
    ]);
    await release("playbook", "pb-1");
    expect((await heldByToken(user)).size).toBe(0);
  });

  it("leaves another source's claim alone", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
      { user, token: "rUSDC", amount: "25", source: "event_order", sourceId: "eo-2" },
    ]);
    await release("event_order", "eo-1");
    expect((await heldByToken(user)).get("rUSDC")?.raw).toBe(USDC(25));
  });

  it("records a kept promise as spent and a broken one as released", async () => {
    // Both stop counting against the balance. The distinction is kept because
    // "this money was traded" and "this order was cancelled" are different
    // facts, and only one of them is worth asking questions about later.
    await reserve([
      { user, token: "rUSDC", amount: "10", source: "event_order", sourceId: "filled" },
      { user, token: "rUSDC", amount: "10", source: "event_order", sourceId: "gone" },
    ]);
    await release("event_order", "filled", "spent");
    await release("event_order", "gone", "released");
    expect(held.rows.map((r) => r.status).sort()).toEqual(["released", "spent"]);
    expect((await heldByToken(user)).size).toBe(0);
  });
});

describe("availability", () => {
  it("subtracts what is held from what the chain reports", async () => {
    state.vaultBalance.mockResolvedValue(USDC(1000));
    await reserve([
      { user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" },
    ]);
    const state_ = await availability(user, "rUSDC");
    expect(state_.balance).toBe(USDC(1000));
    expect(state_.held).toBe(USDC(400));
    expect(state_.available).toBe(USDC(600));
  });

  it("floors at zero rather than reporting a negative as credit", async () => {
    // Somebody can withdraw directly on-chain, behind this ledger's back, and
    // leave claims standing against money that is gone. The one thing that must
    // not happen is a negative reading as spendable.
    state.vaultBalance.mockResolvedValue(USDC(10));
    await reserve([
      { user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" },
    ]);
    expect((await availability(user, "rUSDC")).available).toBe(0n);
  });

  it("reports the whole balance as free when nothing is promised", async () => {
    state.vaultBalance.mockResolvedValue(USDC(500));
    const s = await availability(user, "rUSDC");
    expect(s.available).toBe(USDC(500));
    expect(s.claims).toBe(0);
  });
});

describe("assertWithdrawable", () => {
  beforeEach(() => {
    state.vaultBalance.mockResolvedValue(USDC(1000));
  });

  it("allows a withdrawal that stays inside the free part", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(assertWithdrawable(user, "rUSDC", USDC(600))).resolves.toBeUndefined();
  });

  it("refuses one that dips into committed money, and says what is free", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(assertWithdrawable(user, "rUSDC", USDC(601))).rejects.toThrow(
      "400 rUSDC is committed to 1 live order, so 600 of your 1000 is free to withdraw.",
    );
  });

  it("lets the whole balance go once the order is cancelled", async () => {
    await reserve([
      { user, token: "rUSDC", amount: "400", source: "event_order", sourceId: "eo-1" },
    ]);
    await release("event_order", "eo-1");
    await expect(assertWithdrawable(user, "rUSDC", USDC(1000))).resolves.toBeUndefined();
  });
});

describe("assertVaultFunds against held money", () => {
  const leg = (amount: string) => ({
    tokenIn: "rUSDC",
    tokenOut: "rWETH",
    amount,
    where: "This order",
  });

  it("refuses a second order that would spend the first one's money", async () => {
    // The whole point. 100 in the vault, 100 already promised, so the next
    // order gets nothing -- even though the balance has not moved yet.
    state.vaultBalance.mockResolvedValue(USDC(100));
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(assertVaultFunds(user, [leg("100")])).rejects.toThrow(
      "This order needs 100 rUSDC and your vault has 0 free.",
    );
  });

  it("names the committed money and how to get it back", async () => {
    state.vaultBalance.mockResolvedValue(USDC(100));
    await reserve([
      { user, token: "rUSDC", amount: "80", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(assertVaultFunds(user, [leg("50")])).rejects.toThrow(
      "80 rUSDC is already committed to orders that have not fired yet; cancel one to free it.",
    );
  });

  it("allows a second order that fits in what is left", async () => {
    state.vaultBalance.mockResolvedValue(USDC(100));
    await reserve([
      { user, token: "rUSDC", amount: "60", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(assertVaultFunds(user, [leg("40")])).resolves.toBeUndefined();
  });

  it("allows the order again once the holder is cancelled", async () => {
    state.vaultBalance.mockResolvedValue(USDC(100));
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
    ]);
    await release("event_order", "eo-1");
    await expect(assertVaultFunds(user, [leg("100")])).resolves.toBeUndefined();
  });

  it("refuses a percentage order when every token is spoken for", async () => {
    state.vaultBalance.mockResolvedValue(USDC(100));
    await reserve([
      { user, token: "rUSDC", amount: "100", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(
      assertVaultFunds(user, [{ ...leg("50"), amountIsPercent: true }]),
    ).rejects.toThrow("spends a share of your rUSDC, and your vault has none free");
  });

  it("ignores a hold on a token this order never touches", async () => {
    state.vaultBalance.mockResolvedValue(USDC(100));
    await reserve([
      { user, token: "rWBTC", amount: "1", source: "event_order", sourceId: "eo-1" },
    ]);
    await expect(assertVaultFunds(user, [leg("100")])).resolves.toBeUndefined();
  });
});
