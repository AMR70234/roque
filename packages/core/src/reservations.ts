/**
 * Vault money already promised to something.
 *
 * `funding.ts` answers "can the vault pay for this?" by reading the chain. That
 * was the whole story while every trade was signed and settled in one breath,
 * and it stopped being the whole story the moment an order could rest for a
 * fortnight. An event order is a promise to spend days from now, and until this
 * module existed that promise was invisible: the money sat in the vault looking
 * spendable, counted as available to the next order written against it, and
 * could be withdrawn in full while the order meant to spend it was still armed.
 * Both failures then landed at fill time, on a balance nobody had mentioned.
 *
 * So a commitment now writes a row, and the sum of a user's open rows is the
 * part of their vault that is spoken for. `available` is balance minus that
 * sum, and it is what the funding gate and the withdrawal check both read.
 *
 * Two honest limits, stated here because they are easy to forget once the UI
 * says "locked":
 *
 * This is a ledger, not a lock. `AgentExecutor.withdraw` pays out the whole
 * balance to anyone who calls it directly, because the deployed contract has
 * never heard of this table. Closing that properly needs a `lockedBalance`
 * mapping and a redeploy, which the project's constraints rule out. What this
 * closes is the hole in the app, which is where the money actually leaves from.
 *
 * A percentage order is the awkward case. Its size is decided at fire time
 * against whatever the balance is then, so there is no figure it has committed
 * to in advance. The first cut of this recorded the share and held nothing,
 * which turned out to be useless in exactly the case people reach for first:
 * "spend all of my rUSDC when X happens" held nothing at all, and the vault
 * showed the whole balance as free right up until the order tried to fill.
 *
 * So a share is resolved against the balance at the moment it is promised and
 * that figure is held, with the percentage kept alongside it so the UI can say
 * where the number came from. The fill still recomputes its own size at fire
 * time, so nothing about what actually trades has changed. What the hold is
 * really promising is "this much will still be here", which is the useful
 * guarantee even when the final size is decided later.
 */

import { randomUUID } from "node:crypto";
import { formatUnits, parseUnits } from "viem";
import { tokenBySymbol, type TokenMeta } from "@roque/shared";
import { q } from "./db/index.js";
import { vaultBalance } from "./intents.js";

/** What promised the money. Releasing is keyed to this, not to a row id. */
export type ReservationSource = "event_order" | "playbook";

export interface ReservationInput {
  user: string;
  token: string;
  /** Human units, as written. Ignored when `percent` is set. */
  amount: string;
  /** True when `amount` is a share of the balance rather than a figure. */
  amountIsPercent?: boolean;
  source: ReservationSource;
  sourceId: string;
  /** Which rung of a playbook. Zero for an event order, which has one leg. */
  stepIndex?: number;
}

export interface TokenHold {
  symbol: string;
  /** Absolute units held across every open claim on this token. */
  raw: bigint;
  /** Percent shares claimed but not reservable as a figure. */
  percents: number[];
  /** How many open claims make up this hold. */
  claims: number;
}

interface ReservationRow {
  token: string;
  amount_raw: string;
  percent: string | null;
}

function requireToken(symbol: string): TokenMeta {
  const token = tokenBySymbol(symbol);
  if (!token) throw new Error(`Unknown token ${symbol}.`);
  return token;
}

/**
 * Record a claim. Idempotent on `(source, sourceId, stepIndex)`, so arming a
 * playbook twice or a keeper running twice over one order cannot double-count
 * the same promise — the second write updates the first rather than adding to
 * it. Callers pass every leg at once so one commitment is one round trip.
 */
export async function reserve(legs: ReservationInput[]): Promise<void> {
  for (const leg of legs) {
    const token = requireToken(leg.token);
    const percent = leg.amountIsPercent ? Number(leg.amount) : null;
    let raw: bigint;
    if (percent === null) {
      raw = parseUnits(leg.amount, token.decimals);
    } else {
      // Resolve the share now, against what is free rather than the whole
      // balance, so two "half of my rUSDC" orders promise half and then a
      // quarter instead of both promising half of the same money.
      const free = (await availability(leg.user, token.symbol)).available;
      raw = (free * BigInt(Math.round(percent * 100))) / 10_000n;
    }
    await q(
      `INSERT INTO vault_reservations
         (id, user_address, token, amount_raw, percent, source_kind, source_id, step_index, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'held')
       ON CONFLICT (source_kind, source_id, step_index) DO UPDATE
         SET amount_raw = EXCLUDED.amount_raw,
             percent    = EXCLUDED.percent,
             token      = EXCLUDED.token,
             status     = 'held',
             released_at = NULL`,
      [
        randomUUID(),
        leg.user.toLowerCase(),
        token.symbol,
        raw.toString(),
        percent,
        leg.source,
        leg.sourceId,
        leg.stepIndex ?? 0,
      ],
    );
  }
}

/**
 * Let a claim go. `spent` when the trade actually happened and `released` when
 * it never will; both stop counting against the balance, and the distinction is
 * kept because "this money was used" and "this order was called off" are
 * different facts and somebody will want to tell them apart later.
 *
 * With no `stepIndex` this releases every rung of the source, which is what
 * cancelling a playbook means. With one, it releases that rung alone, which is
 * what finishing a step means.
 */
export async function release(
  source: ReservationSource,
  sourceId: string,
  outcome: "spent" | "released" = "released",
  stepIndex?: number,
): Promise<void> {
  if (stepIndex === undefined) {
    await q(
      `UPDATE vault_reservations SET status=$3, released_at=now()
        WHERE source_kind=$1 AND source_id=$2 AND status='held'`,
      [source, sourceId, outcome],
    );
    return;
  }
  await q(
    `UPDATE vault_reservations SET status=$4, released_at=now()
      WHERE source_kind=$1 AND source_id=$2 AND step_index=$3 AND status='held'`,
    [source, sourceId, stepIndex, outcome],
  );
}

/** Every open claim a user has, grouped by token. */
export async function heldByToken(user: string): Promise<Map<string, TokenHold>> {
  const rows = await q<ReservationRow>(
    `SELECT token, amount_raw, percent FROM vault_reservations
      WHERE LOWER(user_address)=LOWER($1) AND status='held'`,
    [user],
  );
  const held = new Map<string, TokenHold>();
  for (const row of rows) {
    let entry = held.get(row.token);
    if (!entry) {
      entry = { symbol: row.token, raw: 0n, percents: [], claims: 0 };
      held.set(row.token, entry);
    }
    entry.claims += 1;
    // A share carries both: the figure it resolved to when it was promised, and
    // the percentage it came from. The figure counts towards the hold like any
    // other -- it used to be skipped, which meant a percentage order held
    // nothing at all -- and the percentage is kept only so the UI can say where
    // the number came from.
    if (row.percent !== null) entry.percents.push(Number(row.percent));
    // A malformed row must not take down a balance read, and treating it as
    // zero is the safe direction: it under-reports the hold rather than
    // silently blocking a withdrawal the user is entitled to make.
    try {
      entry.raw += BigInt(row.amount_raw);
    } catch {
      /* keep going */
    }
  }
  return held;
}

export interface TokenAvailability {
  symbol: string;
  /** What the chain says is in the vault. */
  balance: bigint;
  /** What open claims have spoken for. */
  held: bigint;
  /** Balance minus held, floored at zero. */
  available: bigint;
  /** Percent shares claimed against this token, which hold no fixed figure. */
  percents: number[];
  claims: number;
}

/**
 * What of one token is actually free to spend or withdraw.
 *
 * Floored at zero because held can exceed balance: somebody can withdraw
 * directly on-chain, behind this ledger's back, and leave claims standing
 * against money that is gone. A negative available would read as a credit,
 * which is the one thing it must never do.
 */
export async function availability(
  user: string,
  symbol: string,
): Promise<TokenAvailability> {
  const token = requireToken(symbol);
  const owner = user.toLowerCase() as `0x${string}`;
  const [balance, held] = await Promise.all([
    vaultBalance(owner, token.address),
    heldByToken(owner),
  ]);
  const hold = held.get(token.symbol);
  const heldRaw = hold?.raw ?? 0n;
  return {
    symbol: token.symbol,
    balance,
    held: heldRaw,
    available: balance > heldRaw ? balance - heldRaw : 0n,
    percents: hold?.percents ?? [],
    claims: hold?.claims ?? 0,
  };
}

/**
 * Refuse a withdrawal that would dip into committed money.
 *
 * The sentence names the shortfall in the token's own units, because "you have
 * 400 committed" is only useful next to "so you can take out 600".
 */
export async function assertWithdrawable(
  user: string,
  symbol: string,
  amountRaw: bigint,
): Promise<void> {
  const token = requireToken(symbol);
  const state = await availability(user, symbol);
  if (amountRaw <= state.available) return;
  const human = (v: bigint) => formatUnits(v, token.decimals);
  const claims = `${state.claims} live order${state.claims === 1 ? "" : "s"}`;
  throw new Error(
    `${human(state.held)} ${token.symbol} is committed to ${claims}, so ${human(state.available)} of your ${human(state.balance)} is free to withdraw. Cancel an order to free the rest.`,
  );
}
