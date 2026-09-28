/**
 * Can the vault actually pay for this?
 *
 * Every unattended trade Roque makes — an event order that fires, a playbook
 * rung that comes due — spends from `AgentExecutor.vaultBalance[user][token]`
 * and from nowhere else. The connected wallet is not touched, because the agent
 * has no authority over it. That is a good property right up until someone
 * writes an order against money the agent cannot reach, at which point the
 * order is not resting, it is broken: it arms, it waits, the condition comes
 * true, and the fill fails on a balance check the person was never shown.
 *
 * `preflightVaultSwap` already refuses that fill. This module moves the same
 * refusal forward to the moment the person signs, which is the only moment they
 * can do anything about it. The rule is deliberately the narrow one the user
 * asked for: enough for *that* trade, judged per leg, not a portfolio model.
 *
 * The arithmetic is pure and the chain read is one thin wrapper over it, so the
 * interesting part — which legs the vault is even on the hook for — is testable
 * without a node.
 */

import { formatUnits, parseUnits } from "viem";
import { tokenBySymbol, type TokenMeta } from "@roque/shared";
import { vaultBalance } from "./intents.js";

/**
 * One trade's claim on the vault. `where` names it in the refusal: a standalone
 * event order calls itself "This order", a playbook rung calls itself "Step 2".
 */
export interface FundingLeg {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  amountIsPercent?: boolean;
  where: string;
}

/** What one token owes across every leg that draws it from the vault. */
export interface FundingNeed {
  symbol: string;
  /** Absolute units the vault must already hold, summed across legs. */
  raw: bigint;
  /** True when some leg spends a percentage, which needs a non-zero balance. */
  needsSome: boolean;
  /** The `where` labels of the legs that put this token on the hook. */
  where: string[];
}

function requireToken(symbol: string): TokenMeta {
  const token = tokenBySymbol(symbol);
  if (!token) throw new Error(`Unknown token ${symbol}.`);
  return token;
}

/**
 * Work out what the vault has to be holding *now* for a list of legs to be
 * payable, in the order they will run.
 *
 * The subtlety is the second rung of a ladder. "Buy rWETH with rUSDC, then sell
 * that rWETH back" is a perfectly good plan to write while holding no rWETH at
 * all, because the first rung is what creates it. So a leg whose input token an
 * earlier leg produces is not the vault's problem and is skipped. Everything
 * else is: two rungs that each spend 100 rUSDC straight from the vault need 200
 * sitting there, not 100 twice.
 *
 * A percentage leg cannot be summed — its size is decided at fire time against
 * whatever the balance is then — so all it asks is that the balance not be
 * zero, since a percentage of nothing is nothing.
 */
export function vaultFundingNeeds(legs: FundingLeg[]): FundingNeed[] {
  const produced = new Set<string>();
  const needs = new Map<string, FundingNeed>();

  for (const leg of legs) {
    const tokenIn = requireToken(leg.tokenIn);
    const tokenOut = requireToken(leg.tokenOut);

    if (!produced.has(tokenIn.symbol)) {
      let need = needs.get(tokenIn.symbol);
      if (!need) {
        need = { symbol: tokenIn.symbol, raw: 0n, needsSome: false, where: [] };
        needs.set(tokenIn.symbol, need);
      }
      if (leg.amountIsPercent) {
        need.needsSome = true;
      } else {
        need.raw += parseUnits(leg.amount, tokenIn.decimals);
      }
      if (!need.where.includes(leg.where)) need.where.push(leg.where);
    }

    produced.add(tokenOut.symbol);
  }

  return [...needs.values()];
}

/** The sentence a person reads when their vault is short. */
function shortfall(need: FundingNeed, balance: bigint, token: TokenMeta): string {
  const who = need.where.join(" and ");
  const have = formatUnits(balance, token.decimals);
  if (need.raw === 0n) {
    return `${who} spends a share of your ${token.symbol}, and your vault holds none. Move some ${token.symbol} into the vault on the autonomous screen first.`;
  }
  return `${who} needs ${formatUnits(need.raw, token.decimals)} ${token.symbol} and your vault holds ${have}. Move the difference into the vault on the autonomous screen, or trade a smaller size.`;
}

/**
 * Refuse the whole thing unless the vault covers every leg that draws on it.
 *
 * Fail closed on purpose. If the balance cannot be read we do not sign, because
 * "we could not check" is not "it is fine", and the cost of being wrong here is
 * an order that looks live and can never fill.
 */
export async function assertVaultFunds(
  user: `0x${string}`,
  legs: FundingLeg[],
): Promise<void> {
  const needs = vaultFundingNeeds(legs);
  if (needs.length === 0) return;

  // Addresses reach this codebase in whatever case the browser had them in and
  // are lowercased at each boundary that cares. The chain read is such a
  // boundary: viem rejects a mixed-case address that is not a valid checksum,
  // and a funding gate that throws "invalid address" instead of a verdict is
  // worse than no gate.
  const owner = user.toLowerCase() as `0x${string}`;
  const balances = await Promise.all(
    needs.map((n) => vaultBalance(owner, requireToken(n.symbol).address)),
  );

  const problems: string[] = [];
  needs.forEach((need, i) => {
    const token = requireToken(need.symbol);
    const balance = balances[i];
    if (balance < need.raw || (need.needsSome && balance === 0n)) {
      problems.push(shortfall(need, balance, token));
    }
  });

  if (problems.length > 0) throw new Error(problems.join(" · "));
}
