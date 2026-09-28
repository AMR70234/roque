"use client";

/**
 * The doorway in front of anything that reads a person's own writing: the
 * conditions they trade on, their playbooks, their inbox. A vault balance is
 * already public on Sepolia, but the sentence somebody chose to bet on is not, so
 * those reads carry a wallet session.
 *
 * The signature is asked for here, by a button, rather than fired on mount.
 * Landing on a page should never raise a wallet prompt nobody asked for. One
 * signature covers every private screen for the rest of the visit.
 */

import { KeyRound, Wallet } from "lucide-react";
import { useAppData } from "@/providers/AppData";

export function PrivateGate({ what }: { what: string }) {
  const { wallet, address, sessionReady, unlocking, unlock } = useAppData();

  if (address && sessionReady) return null;

  if (!address) {
    return (
      <section className="card private-gate">
        <Wallet size={28} />
        <h2 className="private-gate-title">Connect a wallet</h2>
        <p className="private-gate-body">
          {what} belong to an account, and this one spends from your vault when it fires.
        </p>
        <button className="btn btn-primary" onClick={() => wallet.login()}>
          Connect wallet
        </button>
      </section>
    );
  }

  return (
    <section className="card private-gate">
      <KeyRound size={28} />
      <h2 className="private-gate-title">Sign once to read {what.toLowerCase()}</h2>
      <p className="private-gate-body">
        A plain message signature, no gas and no approval. Your balances are public on Sepolia
        already, but what you choose to trade on is yours, so reading it needs proof the wallet is
        in your hands. One signature covers every screen for this visit.
      </p>
      <button className="btn btn-primary" onClick={() => void unlock()} disabled={unlocking}>
        {unlocking ? <span className="spinner" /> : <KeyRound size={15} />}
        Unlock
      </button>
    </section>
  );
}
