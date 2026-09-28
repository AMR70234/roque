"use client";

/**
 * Event orders, given their own room. Write a sentence about the world at the top,
 * and everything you are already watching lists below it, newest first.
 *
 * The screening step is on the card rather than hidden in the write, because it is
 * the interesting part: the validators are asked whether a sentence can be checked
 * against public evidence at all, and a sentence that cannot is refused with its
 * reasoning showing. That refusal is a feature, so it is never tidied away.
 */

import { useState } from "react";
import { Radar, RefreshCw } from "lucide-react";
import { useAppData } from "@/providers/AppData";
import { usePoll } from "@/lib/hooks";
import { api } from "@/lib/api";
import { useToast } from "@/components/Toaster";
import { PrivateGate } from "@/components/PrivateGate";
import { EventOrderComposer } from "@/components/EventOrderComposer";
import { EventOrderCard } from "@/components/EventOrderCard";
import type { EventOrder } from "@/lib/types";

// Long, because the interesting changes here arrive from the keeper minutes
// apart, not second to second.
const POLL_MS = 20_000;

export default function EventsPage() {
  const { address, wallet, sessionReady, refreshAll } = useAppData();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const live = address && sessionReady;
  const orders = usePoll<EventOrder[]>(
    live
      ? async () => {
          const { client } = await wallet.getClient();
          const res = await api.eventOrders(address, client);
          return res.orders;
        }
      : null,
    POLL_MS,
    [address, sessionReady],
  );

  const screen = async (id: string) => {
    if (!address) return;
    setBusy(id);
    const pending = toast.push({
      kind: "pending",
      title: "Asking the validators",
      detail: "Can this sentence be checked at all? A consensus round takes about half a minute.",
    });
    try {
      const { client } = await wallet.getClient();
      const res = await api.screenEventOrder(id, address, client);
      toast.dismiss(pending);
      if (res.order.status === "armed") {
        toast.success("Armed and watching", "Roque will look for evidence on every keeper pass.");
      } else {
        toast.info("Refused, and here is why", res.order.screenReason ?? "Nothing could check it.");
      }
      orders.refresh();
    } catch (err) {
      toast.dismiss(pending);
      toast.error("The screen did not finish", (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const cancel = async (id: string) => {
    if (!address) return;
    setBusy(id);
    try {
      const { client } = await wallet.getClient();
      await api.cancelEventOrder(id, address, client);
      toast.info("Called off", "Nothing will fill from that one.");
      orders.refresh();
      refreshAll();
    } catch (err) {
      toast.error("Could not cancel it", (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const rows = orders.data ?? [];
  const watching = rows.filter((o) => o.status === "armed").length;

  return (
    <div className="events-screen">
      <section className="events-hero">
        <div>
          <h1 className="events-title">Event orders</h1>
          <p className="events-sub">
            A limit order waits on a price. This waits on the world. Describe the event, and a
            network of validators reads the public record and agrees on whether it happened before
            a cent moves. Nothing fills on one machine&rsquo;s opinion.
          </p>
        </div>
        {live ? (
          <div className="events-hero-side">
            <span className="events-count">
              <Radar size={14} />
              {watching} watching
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => orders.refresh()}>
              <RefreshCw size={13} className={orders.loading ? "is-spinning" : ""} />
              Refresh
            </button>
          </div>
        ) : null}
      </section>

      <PrivateGate what="Event orders" />

      {live ? (
        <>
          <EventOrderComposer onCreated={() => orders.refresh()} />

          {orders.error ? <p className="events-error">{orders.error}</p> : null}

          {rows.length === 0 && !orders.loading ? (
            <section className="card events-empty">
              <Radar size={26} />
              <p>
                Nothing on the watch list yet. Write a sentence above and screen it; the refusals are
                worth seeing too.
              </p>
            </section>
          ) : (
            <div className="events-list">
              {rows.map((o) => (
                <EventOrderCard
                  key={o.id}
                  order={o}
                  onScreen={(id) => void screen(id)}
                  onCancel={(id) => void cancel(id)}
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
