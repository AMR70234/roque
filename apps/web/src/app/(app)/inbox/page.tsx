"use client";

/**
 * The inbox, where Roque speaks first. Everywhere else in the app you ask and it
 * answers; here it has been watching your vault, your orders and the market, and
 * brings you the handful of things it thinks are worth a decision.
 *
 * Accepting builds the thing and walks you to it. It never signs and never spends,
 * because an agent that can act unprompted is a different product from one that
 * can suggest unprompted, and this is the second.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Inbox, RefreshCw } from "lucide-react";
import { useAppData } from "@/providers/AppData";
import { api } from "@/lib/api";
import { useToast } from "@/components/Toaster";
import { PrivateGate } from "@/components/PrivateGate";
import { ProposalCard } from "@/components/ProposalCard";

export default function InboxPage() {
  const { address, wallet, sessionReady, proposals: inbox } = useAppData();
  const toast = useToast();
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const live = address && sessionReady;

  // The keeper files these on its own timer. This is for the person who wants to
  // know what Roque thinks right now rather than at the next tick.
  const rethink = async () => {
    if (!address) return;
    setRefreshing(true);
    try {
      const { client } = await wallet.getClient();
      const res = await api.refreshProposals(address, client);
      inbox.refresh();
      toast.info(
        res.filed > 0 ? `${res.filed} new thing${res.filed === 1 ? "" : "s"} to look at` : "Nothing new",
        res.filed > 0 ? "Roque had another look at your positions." : "Roque looked again and found nothing worth raising.",
      );
    } catch (err) {
      toast.error("Could not take another look", (err as Error).message);
    } finally {
      setRefreshing(false);
    }
  };

  const accept = async (id: string) => {
    if (!address) return;
    setBusy(id);
    try {
      const { client } = await wallet.getClient();
      const res = await api.acceptProposal(id, address, client);
      inbox.refresh();
      toast.success("Done", res.created ? "It is on the page now, unarmed until you say so." : "Taken.");
      if (res.href) router.push(res.href);
    } catch (err) {
      toast.error("Could not act on that", (err as Error).message);
      inbox.refresh();
    } finally {
      setBusy(null);
    }
  };

  const dismiss = async (id: string) => {
    if (!address) return;
    setBusy(id);
    try {
      const { client } = await wallet.getClient();
      await api.dismissProposal(id, address, client);
      inbox.refresh();
    } catch (err) {
      toast.error("Could not clear that", (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const rows = inbox.data ?? [];

  return (
    <div className="events-screen">
      <section className="events-hero">
        <div>
          <h1 className="events-title">Inbox</h1>
          <p className="events-sub">
            Roque watches your vault, your open orders and the market between your visits. When
            something is worth a decision it lands here with the reasoning attached. Nothing in this
            list has spent anything; each one is a suggestion waiting on you.
          </p>
        </div>
        {live ? (
          <div className="events-hero-side">
            <span className="events-count">
              <Inbox size={14} />
              {rows.length} waiting
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => void rethink()} disabled={refreshing}>
              <RefreshCw size={13} className={refreshing ? "is-spinning" : ""} />
              Look again
            </button>
          </div>
        ) : null}
      </section>

      <PrivateGate what="Your inbox" />

      {live ? (
        <>
          {inbox.error ? <p className="events-error">{inbox.error}</p> : null}
          {rows.length === 0 && !inbox.loading ? (
            <section className="card events-empty">
              <Inbox size={26} />
              <p>
                Empty, which is the good outcome. Roque raises something when your permission is
                running out, when an order has drifted past reach, or when the market moves enough to
                be worth a word.
              </p>
            </section>
          ) : (
            <div className="events-list">
              {rows.map((p) => (
                <ProposalCard
                  key={p.id}
                  proposal={p}
                  onAccept={(id) => void accept(id)}
                  onDismiss={(id) => void dismiss(id)}
                  busy={busy}
                />
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
