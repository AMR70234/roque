/**
 * Two indexers, one window of blocks.
 *
 * The indexer is already idempotent where it counts: trade rows are keyed on
 * (tx_hash, log_index) with an ON CONFLICT DO NOTHING, so nothing is ever
 * double counted. What was not guarded was the work. Two indexers reading the
 * same bookmark both scanned the same eight hundred blocks and both pulled five
 * sets of logs to do it, against a public RPC with a rate limit. The bookmark
 * is claimed first now, conditional on it still saying what we read, so the
 * loser skips the window instead of racing through it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  q: vi.fn(),
  getBlockNumber: vi.fn(),
  getContractEvents: vi.fn(),
  getBlock: vi.fn(),
}));

vi.mock("../src/db/index.js", () => ({ q: state.q }));
vi.mock("../src/chain.js", () => ({
  publicClient: () => ({
    getBlockNumber: state.getBlockNumber,
    getContractEvents: state.getContractEvents,
    getBlock: state.getBlock,
  }),
}));

const { indexOnce, DEPLOY_BLOCK } = await import("../src/indexer.js");

/** A single-row indexer_state table, with the real compare-and-swap semantics. */
let bookmark: string | null;
let scans: number;

beforeEach(() => {
  vi.clearAllMocks();
  bookmark = null;
  scans = 0;
  state.getBlockNumber.mockResolvedValue(DEPLOY_BLOCK + 5_000n);
  state.getContractEvents.mockImplementation(async () => {
    scans += 1;
    return [];
  });

  state.q.mockImplementation(async (text: string, params: unknown[] = []) => {
    const t = text.replace(/\s+/gu, " ").trim();
    if (t.startsWith("SELECT value FROM indexer_state")) {
      return bookmark === null ? [] : [{ value: bookmark }];
    }
    if (t.startsWith("INSERT INTO indexer_state")) {
      if (bookmark === null) bookmark = String(params[1]);
      return [];
    }
    if (t.startsWith("UPDATE indexer_state")) {
      // The swap: only moves the bookmark if it still says what we read.
      if (bookmark !== String(params[2])) return [];
      bookmark = String(params[1]);
      return [{ key: "last_block" }];
    }
    throw new Error(`Unhandled test query: ${t}`);
  });
});

describe("indexOnce", () => {
  it("claims a window and scans it", async () => {
    const res = await indexOnce();
    expect(res.fromBlock).toBe(DEPLOY_BLOCK);
    expect(res.toBlock).toBeGreaterThan(res.fromBlock);
    expect(bookmark).toBe(res.toBlock.toString());
    expect(scans).toBeGreaterThan(0);
  });

  it("scans each window once however many indexers are running", async () => {
    await Promise.all([indexOnce(), indexOnce(), indexOnce()]);
    // Five getContractEvents calls make up one sweep, so three racing indexers
    // claiming one window between them is one sweep's worth of requests.
    expect(scans).toBe(5);
  });

  it("gives the loser nothing to do rather than a window to redo", async () => {
    const [a, b] = await Promise.all([indexOnce(), indexOnce()]);
    const loser = a.rows === 0 && a.toBlock < a.fromBlock ? a : b;
    expect(loser.toBlock).toBeLessThan(loser.fromBlock);
    expect(loser.rows).toBe(0);
  });

  it("does nothing when the bookmark has already caught up to the head", async () => {
    state.getBlockNumber.mockResolvedValue(DEPLOY_BLOCK);
    bookmark = DEPLOY_BLOCK.toString();
    const res = await indexOnce();
    expect(res.rows).toBe(0);
    expect(scans).toBe(0);
  });
});
