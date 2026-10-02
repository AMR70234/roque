"use client";

/**
 * Which money is at stake here, said out loud.
 *
 * Event orders and playbooks both fire while nobody is watching, which means the
 * agent has to spend from something it holds authority over: the vault, and
 * nothing else. The connected wallet is untouched by design. That is a good
 * property and an invisible one, so this states it on both screens instead of
 * leaving people to infer it from a balance that never moves, or worse, to
 * discover it from a refusal.
 *
 * It shows what is actually in there, because "your vault funds this" and "your
 * vault holds 40 rUSDC" are different amounts of help.
 */

import Link from "next/link";
import { Vault, ArrowRight } from "lucide-react";
import { useAppData } from "@/providers/AppData";
import { formatAmount } from "@/lib/format";
import { TokenIcon } from "./TokenIcon";

export function VaultFundedNotice({ what }: { what: string }) {
  const { vault, address } = useAppData();

  const held = Object.entries(vault.data?.balances ?? {})
    .filter(([, amount]) => Number(amount) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]));

  return (
    <section className="vault-note">
      <span className="vault-note-mark">
        <Vault size={15} />
      </span>
      <div className="vault-note-body">
        <p className="vault-note-line">
          {what} trade from your <strong>agent vault</strong> &mdash; never from your connected
          wallet. They fire when you are not here, so the agent can only spend what you have
          already handed it. Anything it wins lands back in the vault.
        </p>

        {address ? (
          <div className="vault-note-hold">
            {vault.loading && !vault.data ? (
              <span className="vault-note-empty">Reading your vault&hellip;</span>
            ) : held.length > 0 ? (
              <>
                <span className="vault-note-label">In the vault now</span>
                {held.map(([symbol, amount]) => (
                  <span key={symbol} className="vault-note-bal">
                    <TokenIcon symbol={symbol} size={14} />
                    <span className="tabular">{formatAmount(amount)}</span>
                    {symbol}
                  </span>
                ))}
              </>
            ) : (
              <span className="vault-note-empty">
                Your vault is empty, so nothing written here could fill yet.
              </span>
            )}
            <Link className="vault-note-link" href="/autonomous">
              {held.length > 0 ? "Top it up" : "Fund the vault"}
              <ArrowRight size={12} />
            </Link>
          </div>
        ) : null}
      </div>
    </section>
  );
}
