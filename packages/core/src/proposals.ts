/**
 * The proposals inbox: the one place the agent starts the conversation.
 *
 * Everywhere else in Roque a person types first. That makes the agent reactive,
 * and reactive means it only ever helps with what you already thought of. This
 * module inverts it: the agent looks at the vault, the resting orders, the live
 * playbooks and the market, notices the things a person would want flagged, and
 * files each one as something you accept or dismiss with a tap.
 *
 * Two rules keep an inbox from becoming spam.
 *
 * Everything here is deterministic. No proposal is a model's opinion about what
 * you should do; each one is a fact about your account with an action attached.
 * The judgment in this product belongs to the adjudicator, which rules on
 * conditions you wrote, not to a suggestion engine guessing at your intent.
 *
 * And every proposal carries a dedupe key under a unique constraint, bucketed so
 * that a wobbling balance or a drifting price does not mint a fresh row on every
 * pass. Without that the generator, which runs on the keeper's timer, would
 * refile the same observation all day.
 */

import { randomUUID } from "node:crypto";
import { tokenList, tokenBySymbol } from "@roque/shared";
import { formatUnits } from "viem";
import { q } from "./db/index.js";
import { getCapability, vaultBalance } from "./intents.js";
import { openOrders, type OpenOrder } from "./orders.js";
import { ethUsd, tokenUsd } from "./prices.js";
import { createEventOrder, listEventOrders, cancelEventOrder } from "./events.js";
import { createPlaybook, listPlaybooks } from "./playbooks.js";

/** A capability closer to expiry than this is worth mentioning. */
const CAPABILITY_WARN_MS = 3 * 24 * 60 * 60 * 1000;

/** Idle value below this is not worth anybody's attention. */
const IDLE_USD_FLOOR = 25;

/** The move that makes a market proposal worth filing. */
const MOVE_PCT = 5;

/** A resting trigger further than this from spot is unlikely to fill. */
const FAR_TRIGGER_PCT = 25;

export type ProposalStatus = "new" | "accepted" | "dismissed" | "expired";

export type ProposalAction =
  | { type: "event_order"; condition: string; tokenIn: string; tokenOut: string; amount: string; amountIsPercent?: boolean }
  | { type: "playbook"; name: string; note?: string; steps: unknown[] }
  | { type: "cancel_event_order"; id: string }
  | { type: "open"; href: string; label: string };

export interface Proposal {
  id: string;
  user: string;
  kind: string;
  title: string;
  detail: string;
  rationale: string | null;
  action: ProposalAction;
  status: ProposalStatus;
  dedupeKey: string;
  actedAt: string | null;
  resultRef: string | null;
  createdAt: string;
}

interface ProposalRow {
  id: string;
  user_address: string;
  kind: string;
  title: string;
  detail: string;
  rationale: string | null;
  action: ProposalAction;
  status: ProposalStatus;
  dedupe_key: string;
  acted_at: string | null;
  result_ref: string | null;
  created_at: string;
}

function toProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    user: row.user_address,
    kind: row.kind,
    title: row.title,
    detail: row.detail,
    rationale: row.rationale,
    action: row.action,
    status: row.status,
    dedupeKey: row.dedupe_key,
    actedAt: row.acted_at,
    resultRef: row.result_ref,
    createdAt: row.created_at,
  };
}

// ─────────────────────────────────────────────────────────────
// The snapshot the generators read
// ─────────────────────────────────────────────────────────────

export interface VaultHolding {
  symbol: string;
  amount: number;
  usd: number;
}

export interface UserSnapshot {
  user: string;
  now: number;
  vault: VaultHolding[];
  capability: { validUntilMs: number; revoked: boolean } | null;
  openOrders: OpenOrder[];
  eventOrders: Array<{ id: string; status: string; condition: string; screenReason: string | null; tokenIn: string; tokenOut: string; amount: string }>;
  activePlaybooks: number;
  ethUsd: number;
  /** Null when the price history has no usable reading from a day ago. */
  ethUsdYesterday: number | null;
}

export interface ProposalCandidate {
  kind: string;
  title: string;
  detail: string;
  rationale: string | null;
  action: ProposalAction;
  dedupeKey: string;
}

/**
 * Bucket a number so a candidate's identity is stable while the underlying value
 * drifts. This is the whole anti-spam mechanism: without it, $412.03 and $412.11
 * are two different proposals.
 */
function bucket(value: number, size: number): number {
  return Math.round(value / size) * size;
}

function day(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Every generator, as one pure function. Keeping the IO out means the rules that
 * decide what a person is told can be tested exhaustively against a fixture,
 * which matters more here than anywhere else: an inbox that cries wolf gets
 * ignored, and an ignored inbox is worse than none.
 */
export function buildProposals(s: UserSnapshot): ProposalCandidate[] {
  const out: ProposalCandidate[] = [];

  // ── The agent is about to lose its permission slip ──
  if (s.capability && !s.capability.revoked) {
    const left = s.capability.validUntilMs - s.now;
    if (left > 0 && left < CAPABILITY_WARN_MS) {
      const hours = Math.max(1, Math.round(left / (60 * 60 * 1000)));
      out.push({
        kind: "capability-expiring",
        title: "Your agent's permission expires soon",
        detail: `The capability you granted runs out in about ${hours} hour${hours === 1 ? "" : "s"}. When it lapses, armed event orders and playbooks stop being able to fill.`,
        rationale: "Anything waiting on a trigger needs a live capability at the moment it fires, not at the moment you set it up.",
        action: { type: "open", href: "/autonomous", label: "Renew the capability" },
        dedupeKey: `cap-expiry:${s.capability.validUntilMs}`,
      });
    }
  }

  // ── A condition the screen refused, with a concrete way forward ──
  for (const order of s.eventOrders) {
    if (order.status !== "rejected") continue;
    out.push({
      kind: "rejected-condition",
      title: "One of your conditions could not be verified",
      detail: `"${order.condition}" was refused because ${order.screenReason ?? "no public source could settle it"}. Rewrite it around something that gets reported publicly and it will arm.`,
      rationale: "An order nobody can check would rest forever, and any fill it produced would be a guess rather than a verdict.",
      action: { type: "open", href: "/events", label: "Rewrite the condition" },
      dedupeKey: `rejected:${order.id}`,
    });
  }

  // ── A resting trigger the market is nowhere near ──
  for (const order of s.openOrders) {
    const trigger = Number(order.triggerPrice);
    if (!Number.isFinite(trigger) || trigger <= 0 || s.ethUsd <= 0) continue;
    const distance = (Math.abs(trigger - s.ethUsd) / s.ethUsd) * 100;
    const unreachable = order.triggerAbove ? trigger > s.ethUsd : trigger < s.ethUsd;
    if (!unreachable || distance < FAR_TRIGGER_PCT) continue;
    out.push({
      kind: "far-trigger",
      title: `Order #${order.id} is ${Math.round(distance)}% away from filling`,
      detail: `It waits for ETH ${order.triggerAbove ? "above" : "below"} $${trigger.toLocaleString("en-US")} while ETH trades at $${s.ethUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}. That is a long way at current levels.`,
      rationale: "Capital committed to an order that cannot fill is capital doing nothing.",
      action: { type: "open", href: "/autonomous", label: "Review your orders" },
      dedupeKey: `far-order:${order.id}:${bucket(distance, 10)}`,
    });
  }

  // ── The market moved enough to be worth a plan ──
  if (s.ethUsdYesterday && s.ethUsdYesterday > 0) {
    const changePct = ((s.ethUsd - s.ethUsdYesterday) / s.ethUsdYesterday) * 100;
    const stable = s.vault.find((h) => h.symbol === "rUSDC" && h.usd >= IDLE_USD_FLOOR);
    const eth = s.vault.find((h) => h.symbol === "rWETH" && h.usd >= IDLE_USD_FLOOR);

    if (changePct <= -MOVE_PCT && stable) {
      out.push({
        kind: "drawdown-ladder",
        title: `ETH is down ${Math.abs(changePct).toFixed(1)}% since yesterday`,
        detail: `You hold ${stable.amount.toFixed(2)} rUSDC. This sets up a two-step ladder: a quarter in now, another quarter if it falls a further 5%.`,
        rationale: "Laddering commits at two prices instead of betting everything on this one being the low.",
        action: {
          type: "playbook",
          name: "Ladder into the dip",
          note: `Filed after a ${Math.abs(changePct).toFixed(1)}% daily fall.`,
          steps: [
            { trigger: { kind: "immediate" }, action: { tokenIn: "rUSDC", tokenOut: "rWETH", amount: "25", amountIsPercent: true } },
            { trigger: { kind: "price", direction: "below", usd: Math.round(s.ethUsd * 0.95) }, action: { tokenIn: "rUSDC", tokenOut: "rWETH", amount: "25", amountIsPercent: true } },
          ],
        },
        dedupeKey: `drawdown:${day(s.now)}:${bucket(changePct, 5)}`,
      });
    }

    if (changePct >= MOVE_PCT && eth) {
      out.push({
        kind: "rally-trim",
        title: `ETH is up ${changePct.toFixed(1)}% since yesterday`,
        detail: `You hold ${eth.amount.toFixed(4)} rWETH. This takes a fifth off if it gives back half the move, and leaves the rest running.`,
        rationale: "A trailing exit keeps the upside open while deciding in advance what you will do if it turns.",
        action: {
          type: "playbook",
          name: "Trim into strength",
          note: `Filed after a ${changePct.toFixed(1)}% daily rise.`,
          steps: [
            {
              trigger: { kind: "price", direction: "below", usd: Math.round(s.ethUsdYesterday + (s.ethUsd - s.ethUsdYesterday) / 2) },
              action: { tokenIn: "rWETH", tokenOut: "rUSDC", amount: "20", amountIsPercent: true },
            },
          ],
        },
        dedupeKey: `rally:${day(s.now)}:${bucket(changePct, 5)}`,
      });
    }
  }

  // ── Money sitting still with nothing watching it ──
  if (s.activePlaybooks === 0 && s.openOrders.length === 0) {
    const idle = [...s.vault].sort((a, b) => b.usd - a.usd)[0];
    if (idle && idle.usd >= IDLE_USD_FLOOR) {
      const other = idle.symbol === "rUSDC" ? "rWETH" : "rUSDC";
      out.push({
        kind: "idle-vault",
        title: `$${Math.round(idle.usd).toLocaleString("en-US")} of ${idle.symbol} is vaulted with nothing watching it`,
        detail: `Nothing you have armed would act on it. A macro condition is the usual first thing to put behind idle stablecoins.`,
        rationale: "The vault is the only pool the agent can touch; funds sitting in it with no rule attached are funds the agent cannot help with.",
        action: {
          type: "event_order",
          condition: "a major central bank announces a cut to its benchmark interest rate",
          tokenIn: idle.symbol,
          tokenOut: other,
          amount: "20",
          amountIsPercent: true,
        },
        dedupeKey: `idle:${idle.symbol}:${bucket(idle.usd, 100)}`,
      });
    }
  }

  return out;
}

// ─────────────────────────────────────────────────────────────
// Gathering the snapshot
// ─────────────────────────────────────────────────────────────

export async function collectSnapshot(user: string): Promise<UserSnapshot> {
  const owner = user as `0x${string}`;

  const [rawBalances, capability, orders, eventOrders, playbooks, eth, yesterday] =
    await Promise.all([
      Promise.all(tokenList.map((t) => vaultBalance(owner, t.address).catch(() => 0n))),
      getCapability(owner).catch(() => null),
      openOrders(owner).catch(() => [] as OpenOrder[]),
      listEventOrders(user, 50).catch(() => []),
      listPlaybooks(user, 50).catch(() => []),
      ethUsd().catch(() => ({ usd: 0 })),
      // The nearest reading at least a day old. The history is sampled rather
      // than continuous, so a week's slack is what makes this usable at all,
      // and a null result simply retires the two market generators.
      q<{ price: string }>(
        `SELECT price::text FROM price_history
          WHERE pair='rWETH/USD' AND recorded_at <= now() - interval '24 hours'
            AND recorded_at >= now() - interval '7 days'
          ORDER BY recorded_at DESC LIMIT 1`,
      ).catch(() => []),
    ]);

  // Value each holding. A feed that is down should cost us that one line, not
  // the whole snapshot, so a failed price reads as zero and drops out.
  const vault: VaultHolding[] = [];
  for (const [i, token] of tokenList.entries()) {
    const raw = rawBalances[i];
    if (raw <= 0n) continue;
    const amount = Number(formatUnits(raw, token.decimals));
    const price = await tokenUsd(token.symbol).catch(() => 0);
    vault.push({ symbol: token.symbol, amount, usd: amount * price });
  }

  return {
    user,
    now: Date.now(),
    vault,
    capability: capability
      ? { validUntilMs: Number(capability.validUntil) * 1000, revoked: capability.revoked }
      : null,
    openOrders: orders,
    eventOrders: eventOrders.map((o) => ({
      id: o.id,
      status: o.status,
      condition: o.condition,
      screenReason: o.screenReason,
      tokenIn: o.tokenIn,
      tokenOut: o.tokenOut,
      amount: o.amount,
    })),
    activePlaybooks: playbooks.filter((p) => p.status === "armed").length,
    ethUsd: eth.usd,
    ethUsdYesterday: yesterday[0] ? Number(yesterday[0].price) : null,
  };
}

/**
 * File any candidate that is not already on the user's desk. The insert leans on
 * the unique constraint rather than a read-then-write, so two concurrent ticks
 * cannot both decide a proposal is new.
 */
export async function generateProposals(user: string): Promise<Proposal[]> {
  const candidates = buildProposals(await collectSnapshot(user));
  const filed: Proposal[] = [];

  for (const c of candidates) {
    const rows = await q<ProposalRow>(
      `INSERT INTO proposals (id, user_address, kind, title, detail, rationale, action, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
       ON CONFLICT (user_address, dedupe_key) DO NOTHING RETURNING *`,
      [
        randomUUID(),
        user.toLowerCase(),
        c.kind,
        c.title,
        c.detail,
        c.rationale,
        JSON.stringify(c.action),
        c.dedupeKey,
      ],
    );
    if (rows[0]) filed.push(toProposal(rows[0]));
  }
  return filed;
}

// ─────────────────────────────────────────────────────────────
// The inbox
// ─────────────────────────────────────────────────────────────

export async function listProposals(
  user: string,
  status: ProposalStatus | "all" = "new",
  limit = 50,
): Promise<Proposal[]> {
  const rows =
    status === "all"
      ? await q<ProposalRow>(
          `SELECT * FROM proposals WHERE LOWER(user_address)=LOWER($1)
            ORDER BY created_at DESC LIMIT $2`,
          [user, limit],
        )
      : await q<ProposalRow>(
          `SELECT * FROM proposals WHERE LOWER(user_address)=LOWER($1) AND status=$2
            ORDER BY created_at DESC LIMIT $3`,
          [user, status, limit],
        );
  return rows.map(toProposal);
}

export async function dismissProposal(id: string, user: string): Promise<Proposal> {
  const rows = await q<ProposalRow>(
    `UPDATE proposals SET status='dismissed', acted_at=now()
      WHERE id=$1 AND LOWER(user_address)=LOWER($2) AND status='new' RETURNING *`,
    [id, user],
  );
  if (!rows[0]) throw new Error("That proposal is not yours, or you already acted on it.");
  return toProposal(rows[0]);
}

export interface AcceptResult {
  proposal: Proposal;
  created: { kind: "event_order" | "playbook"; id: string } | null;
  href: string | null;
}

/**
 * Accept a proposal and carry out its action. The status moves first, under a
 * condition that only a still-new proposal satisfies, so a double tap cannot
 * create the same playbook twice. Anything created arrives unarmed, exactly as a
 * fork does: accepting a suggestion is not the same as authorising a trade.
 */
export async function acceptProposal(id: string, user: string): Promise<AcceptResult> {
  const claimed = await q<ProposalRow>(
    `UPDATE proposals SET status='accepted', acted_at=now()
      WHERE id=$1 AND LOWER(user_address)=LOWER($2) AND status='new' RETURNING *`,
    [id, user],
  );
  if (!claimed[0]) throw new Error("That proposal is not yours, or you already acted on it.");
  const proposal = toProposal(claimed[0]);
  const action = proposal.action;

  try {
    switch (action.type) {
      case "event_order": {
        if (!tokenBySymbol(action.tokenIn) || !tokenBySymbol(action.tokenOut)) {
          throw new Error("That proposal names a token I no longer trade.");
        }
        const order = await createEventOrder({
          user,
          condition: action.condition,
          tokenIn: action.tokenIn,
          tokenOut: action.tokenOut,
          amount: action.amount,
          amountIsPercent: action.amountIsPercent,
        });
        await stampResult(id, `event_order:${order.id}`);
        return { proposal, created: { kind: "event_order", id: order.id }, href: "/events" };
      }
      case "playbook": {
        const playbook = await createPlaybook({
          user,
          name: action.name,
          note: action.note,
          steps: action.steps,
        });
        await stampResult(id, `playbook:${playbook.id}`);
        return { proposal, created: { kind: "playbook", id: playbook.id }, href: "/playbooks" };
      }
      case "cancel_event_order": {
        await cancelEventOrder(action.id, user);
        await stampResult(id, `cancelled:${action.id}`);
        return { proposal, created: null, href: "/events" };
      }
      case "open":
        await stampResult(id, action.href);
        return { proposal, created: null, href: action.href };
    }
  } catch (err) {
    // Put it back on the desk. A proposal whose action failed is still live work,
    // and silently marking it accepted would lose it.
    await q(`UPDATE proposals SET status='new', acted_at=NULL WHERE id=$1`, [id]);
    throw err;
  }
}

async function stampResult(id: string, ref: string): Promise<void> {
  await q(`UPDATE proposals SET result_ref=$2 WHERE id=$1`, [id, ref]);
}

export interface ProposalTickResult {
  users: number;
  filed: number;
  errors: string[];
}

/**
 * Generate for everyone who has used the product recently. Scoping to recent
 * activity keeps the pass cheap as the user table grows, and somebody who has
 * not been here in a month is not waiting on an inbox.
 */
export async function proposalTick(): Promise<ProposalTickResult> {
  const result: ProposalTickResult = { users: 0, filed: 0, errors: [] };
  const users = await q<{ user_address: string }>(
    `SELECT DISTINCT user_address FROM (
       SELECT user_address FROM intents WHERE created_at > now() - interval '30 days'
       UNION SELECT user_address FROM event_orders WHERE created_at > now() - interval '30 days'
       UNION SELECT user_address FROM playbooks WHERE created_at > now() - interval '30 days'
     ) AS active LIMIT 50`,
  );
  for (const { user_address } of users) {
    try {
      result.filed += (await generateProposals(user_address)).length;
      result.users += 1;
    } catch (err) {
      result.errors.push(`proposals ${user_address}: ${(err as Error).message}`);
    }
  }
  return result;
}
