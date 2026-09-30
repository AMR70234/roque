/**
 * The vault-funding check, browser side.
 *
 * `@roque/core` owns the real one: it reads the chain and it is what actually
 * refuses an order. That refusal is correct but late — it arrives as a toast
 * after a click, on a form the person has already finished filling in. This is
 * the same arithmetic run against the vault balance the app is already polling,
 * so the button can be plainly unavailable with the reason next to it instead.
 *
 * The two halves are deliberately kept in step, including the awkward part: a
 * rung that spends what an earlier rung bought is funded by the ladder itself
 * and is not the vault's problem. If they ever disagree the server wins, because
 * it is reading the chain and this is reading a poll that may be seconds old.
 *
 * When the vault has not loaded yet this says nothing at all. Blocking a button
 * on a number we do not have would be worse than letting the server answer.
 *
 * What it compares against is `availableRaw` rather than the plain balance, for
 * the same reason the server does: an armed event order has already promised
 * part of the vault, and money promised twice is money one of the two orders
 * will not get.
 */

import { formatUnits, parseUnits } from "viem";
import { tokenBySymbol } from "@roque/shared";

export interface FundingLeg {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  amountIsPercent?: boolean;
  /** How the refusal names this leg: "This order", or "Step 2". */
  where: string;
}

/**
 * Spendable vault balances keyed by symbol. Pass `VaultResult.availableRaw`,
 * which is the balance with every resting order's claim already taken out.
 */
export type VaultRaw = Record<string, string> | undefined;

function safeParse(amount: string, decimals: number): bigint | null {
  try {
    return parseUnits(amount, decimals);
  } catch {
    // Mid-typing states like "1." land here. Nothing to say about them yet.
    return null;
  }
}

/**
 * The one sentence to show, or null when the vault covers everything it is being
 * asked for. Legs are read in the order they will run.
 */
export function vaultShortfall(legs: FundingLeg[], raw: VaultRaw): string | null {
  if (!raw) return null;

  const produced = new Set<string>();
  const need = new Map<string, { raw: bigint; needsSome: boolean; where: string[] }>();

  for (const leg of legs) {
    const tokenIn = tokenBySymbol(leg.tokenIn);
    const tokenOut = tokenBySymbol(leg.tokenOut);
    if (!tokenIn || !tokenOut) return null; // The server's refusal is the right one here.

    if (!produced.has(tokenIn.symbol)) {
      let entry = need.get(tokenIn.symbol);
      if (!entry) {
        entry = { raw: 0n, needsSome: false, where: [] };
        need.set(tokenIn.symbol, entry);
      }
      if (leg.amountIsPercent) {
        entry.needsSome = true;
      } else {
        const parsed = safeParse(leg.amount, tokenIn.decimals);
        if (parsed === null) return null;
        entry.raw += parsed;
      }
      if (!entry.where.includes(leg.where)) entry.where.push(leg.where);
    }

    produced.add(tokenOut.symbol);
  }

  for (const [symbol, entry] of need) {
    const token = tokenBySymbol(symbol);
    if (!token) continue;
    const held = raw[symbol];
    if (held === undefined) continue;
    let balance: bigint;
    try {
      balance = BigInt(held);
    } catch {
      continue;
    }

    const who = entry.where.join(" and ");
    if (entry.raw === 0n && entry.needsSome && balance === 0n) {
      return `${who} spends a share of your ${symbol}, and your vault holds none. Move some ${symbol} in first.`;
    }
    if (entry.raw > 0n && balance < entry.raw) {
      return `${who} needs ${formatUnits(entry.raw, token.decimals)} ${symbol}, and your vault holds ${formatUnits(balance, token.decimals)}. Move the difference in, or trade a smaller size.`;
    }
  }

  return null;
}
