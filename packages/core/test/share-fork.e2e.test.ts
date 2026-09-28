/**
 * Forking a shared link.
 *
 * A share row is data a stranger's browser produced, so the interesting tests
 * are the distrustful ones: every stored step is validated again on the way in,
 * and the forker's own sizing wins over the author's. The author's position size
 * says nothing about what this person should risk, which is the whole reason the
 * link carries a thesis rather than a trade.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaybookStep } from "../src/playbooks.js";
import type { EventOrderPayload, PlaybookPayload } from "../src/shares.js";

const state = vi.hoisted(() => ({ q: vi.fn() }));

vi.mock("../src/db/index.js", () => ({ q: state.q }));
// Nothing on the fork path touches the chain or a model; stubbing these keeps
// the import graph inert rather than papering over a real call.
vi.mock("../src/services.js", () => ({
  preflightVaultSwap: vi.fn(),
  executeVaultSwap: vi.fn(),
}));
vi.mock("../src/genlayer.js", () => ({ adjudicate: vi.fn(), interpret: vi.fn() }));
vi.mock("../src/prices.js", () => ({
  ethUsd: vi.fn(),
  tokenUsd: vi.fn(),
  toTriggerPrice: vi.fn(),
  usdValueRaw: vi.fn(),
}));

const { forkShare } = await import("../src/shares.js");
const { normaliseStep } = await import("../src/playbooks.js");

const author = "0x2222222222222222222222222222222222222222";
// Deliberately mixed case: the fork must be stored under the lowercased address
// so every later owner-scoped read matches it.
const forker = "0xAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCdEfAbCd";
const SLUG = "fed-cut-ladder-Xk3mQ7z";
const CONDITION = "the Federal Reserve cuts its benchmark interest rate";

const eventPayload: EventOrderPayload = {
  condition: CONDITION,
  tokenIn: "rUSDC",
  tokenOut: "rWETH",
  amount: "1000",
  amountIsPercent: false,
  slippageBps: 100,
};

function step(amount: string, trigger: unknown = { kind: "immediate" }): PlaybookStep {
  return normaliseStep(
    { trigger, action: { tokenIn: "rUSDC", tokenOut: "rWETH", amount, amountIsPercent: true } },
    0,
  );
}

const playbookPayload = (steps: PlaybookStep[]): PlaybookPayload => ({
  name: "Ladder into the dip",
  note: "Two rungs, not one guess.",
  steps,
  slippageBps: 100,
});

let share: Record<string, unknown> | undefined;
let inserted: { table: string; params: unknown[] } | null;
let forkBumps: string[];

beforeEach(() => {
  vi.clearAllMocks();
  inserted = null;
  forkBumps = [];
  share = undefined;

  state.q.mockImplementation(async (text: string, params: unknown[] = []) => {
    const t = text.replace(/\s+/gu, " ").trim();

    if (t.startsWith("SELECT * FROM shares WHERE slug=$1")) return share ? [{ ...share }] : [];

    if (t.startsWith("INSERT INTO event_orders")) {
      inserted = { table: "event_orders", params };
      return [
        {
          id: params[0],
          user_address: params[1],
          condition: params[2],
          token_in: params[3],
          token_out: params[4],
          amount: params[5],
          amount_is_percent: params[6],
          slippage_bps: params[7],
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
          expires_at: "2026-01-16T00:00:00.000Z",
          tx_hash: null,
          error: null,
          source_slug: params[9],
          created_at: "2026-01-02T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
      ];
    }

    if (t.startsWith("INSERT INTO playbooks")) {
      inserted = { table: "playbooks", params };
      return [
        {
          id: params[0],
          user_address: params[1],
          name: params[2],
          note: params[3],
          status: "draft",
          steps: JSON.parse(String(params[4])),
          step_cursor: 0,
          slippage_bps: params[5],
          last_checked_at: null,
          error: null,
          source_slug: params[6],
          created_at: "2026-01-02T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
      ];
    }

    if (t.startsWith("UPDATE shares SET forks = forks + 1")) {
      forkBumps.push(String(params[0]));
      return [];
    }

    throw new Error(`Unhandled test query: ${t}`);
  });
});

function shareRow(kind: "event_order" | "playbook", payload: unknown) {
  return {
    slug: SLUG,
    kind,
    author_address: author,
    title: "Ladder into a Fed cut",
    note: null,
    payload,
    forks: 3,
    views: 40,
    created_at: "2026-01-01T00:00:00.000Z",
  };
}

describe("forkShare", () => {
  it("refuses a slug nobody published", async () => {
    await expect(forkShare("not-a-real-slug", forker)).rejects.toThrow("No such link.");
  });

  describe("an event order", () => {
    beforeEach(() => {
      share = shareRow("event_order", eventPayload);
    });

    it("copies the thesis into the forker's own account", async () => {
      const result = await forkShare(SLUG, forker);

      expect(result.kind).toBe("event_order");
      if (result.kind !== "event_order") throw new Error("wrong branch");
      expect(result.order.condition).toBe(CONDITION);
      expect(result.order.tokenIn).toBe("rUSDC");
      expect(result.order.tokenOut).toBe("rWETH");
      // The fork is the forker's order, under the forker's lowercased address,
      // and it screens from scratch rather than inheriting the author's verdict.
      expect(result.order.user).toBe(forker.toLowerCase());
      expect(result.order.status).toBe("screening");
      // The link it came from is recorded, which is what makes a fork traceable.
      expect(result.order.sourceSlug).toBe(SLUG);
    });

    it("takes the author's size only when the forker names none", async () => {
      await forkShare(SLUG, forker);
      expect(inserted!.params[5]).toBe("1000");
      expect(inserted!.params[6]).toBe(false);
    });

    it("lets the forker size the position themselves", async () => {
      const result = await forkShare(SLUG, forker, {
        amount: "20",
        amountIsPercent: true,
        slippageBps: 250,
      });

      if (result.kind !== "event_order") throw new Error("wrong branch");
      expect(result.order.amount).toBe("20");
      expect(result.order.amountIsPercent).toBe(true);
      expect(result.order.slippageBps).toBe(250);
    });

    it("counts the fork against the source link", async () => {
      await forkShare(SLUG, forker);
      expect(forkBumps).toEqual([SLUG]);
    });

    it("validates the stored payload rather than trusting it", async () => {
      // A share published before a token was delisted must not create an order
      // that can never fill.
      share = shareRow("event_order", { ...eventPayload, tokenIn: "WETH" });
      await expect(forkShare(SLUG, forker)).rejects.toThrow("Unknown token WETH.");
      expect(forkBumps).toEqual([]);
    });

    it("refuses a payload whose amount is not a positive number", async () => {
      share = shareRow("event_order", { ...eventPayload, amount: "0" });
      await expect(forkShare(SLUG, forker)).rejects.toThrow(
        "The amount has to be a positive number.",
      );
    });
  });

  describe("a playbook", () => {
    beforeEach(() => {
      share = shareRow("playbook", playbookPayload([step("25"), step("25")]));
    });

    it("copies the plan into the forker's own account as a draft", async () => {
      const result = await forkShare(SLUG, forker);

      expect(result.kind).toBe("playbook");
      if (result.kind !== "playbook") throw new Error("wrong branch");
      expect(result.playbook.user).toBe(forker.toLowerCase());
      expect(result.playbook.name).toBe("Ladder into the dip");
      expect(result.playbook.note).toBe("Two rungs, not one guess.");
      expect(result.playbook.status).toBe("draft");
      expect(result.playbook.sourceSlug).toBe(SLUG);
      expect(result.playbook.steps).toHaveLength(2);
      expect(forkBumps).toEqual([SLUG]);
    });

    it("re-normalises every stored step into a fresh waiting one", async () => {
      const original = playbookPayload([step("25"), step("25")]);
      // Dirty the stored copy the way a half-run playbook would look.
      original.steps[0] = {
        ...original.steps[0]!,
        status: "done",
        txHash: "0xdead",
        checks: 9,
        firedAt: "2026-01-01T00:00:00.000Z",
      };
      share = shareRow("playbook", original);

      const result = await forkShare(SLUG, forker);
      if (result.kind !== "playbook") throw new Error("wrong branch");

      for (const s of result.playbook.steps) {
        expect(s.status).toBe("waiting");
        expect(s.txHash).toBeNull();
        expect(s.checks).toBe(0);
        expect(s.firedAt).toBeNull();
        expect(s.armedAt).toBeNull();
      }
      // A fresh id, so the fork's history can never be confused with the author's.
      expect(result.playbook.steps[0]!.id).not.toBe(original.steps[0]!.id);
    });

    it("scales the first step to the forker's size and leaves the ladder's shape alone", async () => {
      // The later rungs carry the plan's relative sizing, which is usually what
      // the author meant; rewriting them all would change the strategy.
      const result = await forkShare(SLUG, forker, { amount: "50" });
      if (result.kind !== "playbook") throw new Error("wrong branch");

      expect(result.playbook.steps[0]!.action.amount).toBe("50");
      expect(result.playbook.steps[1]!.action.amount).toBe("25");
    });

    it("keeps each step's own trigger", async () => {
      share = shareRow(
        "playbook",
        playbookPayload([
          step("25"),
          step("25", { kind: "price", direction: "below", usd: 2_565 }),
        ]),
      );

      const result = await forkShare(SLUG, forker);
      if (result.kind !== "playbook") throw new Error("wrong branch");

      expect(result.playbook.steps[0]!.trigger).toEqual({ kind: "immediate" });
      expect(result.playbook.steps[1]!.trigger).toEqual({
        kind: "price",
        direction: "below",
        usd: 2_565,
      });
    });

    it("lets the forker set slippage for the whole plan", async () => {
      const result = await forkShare(SLUG, forker, { slippageBps: 300 });
      if (result.kind !== "playbook") throw new Error("wrong branch");
      expect(result.playbook.slippageBps).toBe(300);
    });

    it("refuses a stored step that is no longer valid", async () => {
      // Cast past the type, because this is exactly the shape a stale or hostile
      // share row can have and the runtime check is what has to catch it.
      const bad = {
        ...step("25"),
        action: { tokenIn: "WETH", tokenOut: "rWETH", amount: "25", amountIsPercent: true },
      } as PlaybookStep;
      share = shareRow("playbook", playbookPayload([bad]));

      await expect(forkShare(SLUG, forker)).rejects.toThrow("step 1 names a token I do not trade.");
      expect(forkBumps).toEqual([]);
    });
  });
});
