/**
 * One wallet, several things wanting to send at once.
 *
 * Every Sepolia write Roque makes leaves from the relayer address: the keeper
 * filling a triggered limit order, the judgment loop filling an event order, a
 * playbook advancing a rung, somebody arming an order and locking the money
 * behind it. Fired off in parallel they each asked the node for the next nonce,
 * all got the same answer, and all but one came back "replacement transaction
 * underpriced". Nothing was lost but the work, and the failure was unreadable:
 * a fill that reverts on a nonce collision looks exactly like a fill the
 * contract refused.
 *
 * So the interesting assertion here is not that sends succeed. It is that two
 * sends never carry the same nonce, however many go out at once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sendTransaction: vi.fn(),
  getTransactionCount: vi.fn(),
  waitForTransactionReceipt: vi.fn(),
}));

vi.mock("viem", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    createWalletClient: () => ({
      account: { address: "0x1111111111111111111111111111111111111111" },
      chain: { id: 11155111 },
      sendTransaction: state.sendTransaction,
    }),
    createPublicClient: () => ({
      getTransactionCount: state.getTransactionCount,
      waitForTransactionReceipt: state.waitForTransactionReceipt,
    }),
  };
});

process.env.AGENT_SIGNER_PRIVATE_KEY =
  "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
process.env.DEPLOYER_PRIVATE_KEY =
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba";
process.env.DATABASE_URL = "postgresql://ci:ci@127.0.0.1:5432/roque";

const { sendRelayerTx, confirmTx } = await import("../src/chain.js");

const TO = "0x2222222222222222222222222222222222222222" as const;
const DATA = "0xdeadbeef" as const;

/**
 * The nonce each call was sent with, in the order the wallet saw them.
 *
 * The counter is module state, deliberately: it is the thing that survives
 * between sends. So these assert the relationship between calls rather than
 * absolute values, which would only be describing the order the file runs in.
 */
const noncesUsed = (): number[] =>
  state.sendTransaction.mock.calls.map((c) => (c[0] as { nonce: number }).nonce);

beforeEach(() => {
  vi.clearAllMocks();
  // The node reports the same pending count until a transaction propagates,
  // which is exactly the lag that used to produce the collision.
  state.getTransactionCount.mockResolvedValue(7);
  state.sendTransaction.mockImplementation(async () => "0xhash");
});

describe("sendRelayerTx", () => {
  it("gives every concurrent send its own nonce", async () => {
    await Promise.all(
      Array.from({ length: 5 }, () => sendRelayerTx({ to: TO, data: DATA })),
    );
    const used = noncesUsed();
    expect(new Set(used).size).toBe(5);
    // Consecutive, which is what a node will actually accept: a gap stalls the
    // queue behind it until the missing one arrives.
    expect(used).toEqual([used[0], used[0] + 1, used[0] + 2, used[0] + 3, used[0] + 4]);
  });

  it("sends one at a time rather than all at once", async () => {
    let inFlight = 0;
    let peak = 0;
    state.sendTransaction.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return "0xhash";
    });

    await Promise.all(
      Array.from({ length: 4 }, () => sendRelayerTx({ to: TO, data: DATA })),
    );
    expect(peak).toBe(1);
  });

  it("keeps going after one send fails, and re-reads the chain", async () => {
    // A failure means our local count is no longer trustworthy: the send may
    // have landed and we lost the answer. Dropping it costs one extra round
    // trip and cannot leave a permanent gap, which is the safe direction.
    state.sendTransaction
      .mockImplementationOnce(async () => {
        throw new Error("rpc fell over");
      })
      .mockImplementation(async () => "0xhash");
    state.getTransactionCount.mockResolvedValueOnce(7).mockResolvedValue(9);

    await expect(sendRelayerTx({ to: TO, data: DATA })).rejects.toThrow("rpc fell over");
    await sendRelayerTx({ to: TO, data: DATA });
    // The second one took the chain's answer rather than carrying on from a
    // count the failure made meaningless.
    expect(noncesUsed()[1]).toBe(9);
  });

  it("never lets a stale local count fall behind the chain", async () => {
    // Somebody else spent from the same key, or a restart lost our place.
    await sendRelayerTx({ to: TO, data: DATA });
    state.getTransactionCount.mockResolvedValue(40);
    await sendRelayerTx({ to: TO, data: DATA });
    expect(noncesUsed()[1]).toBe(40);
  });
});

describe("confirmTx", () => {
  it("is quiet when the chain accepted it", async () => {
    state.waitForTransactionReceipt.mockResolvedValue({ status: "success" });
    await expect(confirmTx("0xhash", "Holding the money")).resolves.toBeUndefined();
  });

  it("says what failed when the chain refused it", async () => {
    // This is what turns a reverted hold into a sentence at arming time rather
    // than an order that looks armed and can never fill.
    state.waitForTransactionReceipt.mockResolvedValue({ status: "reverted" });
    await expect(confirmTx("0xhash", "Holding the money")).rejects.toThrow(
      "Holding the money was rejected on-chain",
    );
  });
});
