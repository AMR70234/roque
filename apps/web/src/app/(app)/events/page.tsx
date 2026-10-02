"use client";

/**
 * Event orders, given their own room. Write a sentence about the world at the top,
 * and everything you are already watching lists below it, newest first.
 *
 * The screening step is on the card rather than hidden in the write, because it is
 * the interesting part: the validators are asked whether a sentence can be checked
 * against public evidence at all, and a sentence that cannot is refused with its
 * reasoning showing. That refusal is a feature, so it is never tidied away.
 *
 * Three presses, not one, and the split is deliberate. Writing records the
 * sentence. Screening asks the validators whether it could be checked. Arming is
 * the person deciding to put money behind the answer, and it is the only one of
 * the three that sets any aside. Folding the last two together meant a sentence
 * became a live commitment on somebody else's verdict with nobody pressing
 * anything.
 */

import { useState } from "react";
import { Radar, RefreshCw } from "lucide-react";
import { useAppData } from "@/providers/AppData";
import { api, StillWorkingError } from "@/lib/api";
import { useToast } from "@/components/Toaster";
import { PrivateGate } from "@/components/PrivateGate";
import { VaultFundedNotice } from "@/components/VaultFundedNotice";
import { EventOrderComposer } from "@/components/EventOrderComposer";
import { EventOrderCard } from "@/components/EventOrderCard";
import {
  EventOrderFilter,
  filterEventOrders,
  type EventGroup,
  type EventPeriod,
} from "@/components/EventOrderFilter";

export default function EventsPage() {
  // The rows come from the shared poll rather than a second one of our own: the
  // inbox chat answers questions about these same orders, and two polls against
  // one list would disagree with each other for twenty seconds at a time.
  const { address, sessionReady, refreshAll, wallet, eventOrders: orders } = useAppData();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const [group, setGroup] = useState<EventGroup>("all");
  const [period, setPeriod] = useState<EventPeriod>("all");

  const live = address && sessionReady;

  /**
   * How long to keep watching a screen that outlived its request, and how often
   * to look. A round measures 23-68s and the judgment loop retries a stranded
   * one within five minutes, so six minutes of watching covers both the slow
   * tail and one pass of the fallback.
   */
  const SCREEN_WATCH_MS = 6 * 60 * 1000;
  const SCREEN_POLL_MS = 5_000;

  /**
   * Report what a screen decided, once it has decided anything.
   *
   * Reading the row rather than the response is the point. A screen is a
   * consensus round that outlives its own request often enough to matter, and
   * the previous shape treated that as a failure: the request 504'd, the person
   * was told their order was untouched and to press again, and pressing again
   * inside two minutes hit the lease that stops two workers buying the same
   * round, returned the row unchanged, and fell into an else branch that
   * announced "Refused, and here is why. Nothing could check it." The order had
   * not been refused at all. So the verdict now comes from the order's own
   * status, whichever way the request went.
   */
  const watchScreen = async (id: string): Promise<void> => {
    const deadline = Date.now() + SCREEN_WATCH_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, SCREEN_POLL_MS));
      if (!address) return;
      try {
        const { client } = await wallet.getClient();
        const { orders: rows } = await api.eventOrders(address, client);
        const row = rows.find((o) => o.id === id);
        if (!row || row.status === "screening") continue;
        orders.refresh();
        report(row.status, row.screenReason);
        return;
      } catch {
        // A poll that fails is not news. The next one is five seconds away.
      }
    }
    orders.refresh();
    toast.info(
      "Still with the validators",
      "The round is taking longer than usual. It keeps running without you, and the order updates itself the moment there is a verdict.",
    );
  };

  /** The one place a screening outcome turns into a sentence. */
  const report = (status: string, reason: string | null) => {
    if (status === "screened") {
      toast.success(
        "The validators can check it",
        "Arm it when you are ready. Nothing is held, and nothing can fill, until you do.",
      );
      return;
    }
    if (status === "rejected") {
      toast.info("Refused, and here is why", reason ?? "No public source could settle it.");
      return;
    }
    // Anything else means the order moved on without us, which is worth saying
    // plainly rather than guessing at.
    toast.info("That order has moved on", `It now reads as ${status}.`);
  };

  const screen = async (id: string) => {
    if (!address) return;
    setBusy(id);
    const pending = toast.push({
      kind: "pending",
      title: "Asking the validators",
      detail: "Can this sentence be checked at all? A consensus round usually takes under a minute.",
    });
    try {
      const { client } = await wallet.getClient();
      const res = await api.screenEventOrder(id, address, client);
      toast.dismiss(pending);
      orders.refresh();
      if (res.order.status === "screening") {
        // The round is running: either ours, or one a worker already had in
        // flight when we asked. Either way the answer is coming.
        await watchScreen(id);
      } else {
        report(res.order.status, res.order.screenReason);
      }
    } catch (err) {
      toast.dismiss(pending);
      if (err instanceof StillWorkingError) {
        toast.info(
          "Still running",
          "A consensus round outlasted the request. Nothing is lost and the order is untouched; this screen keeps watching for the verdict.",
        );
        await watchScreen(id);
      } else {
        toast.error("The screen did not finish", (err as Error).message);
        orders.refresh();
      }
    } finally {
      setBusy(null);
    }
  };

  /**
   * Arming is deliberately its own press. The screen answers whether the
   * condition could be checked; this is the person deciding to put money behind
   * it, and it is the moment the vault money is set aside.
   */
  const arm = async (id: string) => {
    if (!address) return;
    setBusy(id);
    // Arming writes a hold into the vault contract and waits for it, so this is
    // a transaction and not an instant. Saying so beats a button that sits
    // there looking stuck for half a minute.
    const pending = toast.push({
      kind: "pending",
      title: "Arming the order",
      detail: "Setting the money aside in the vault contract. This is a transaction, so give it a moment.",
    });
    try {
      const { client } = await wallet.getClient();
      await api.armEventOrder(id, address, client);
      toast.dismiss(pending);
      toast.success(
        "Armed and watching",
        "The vault is holding this order's money now, so nothing else can spend it. Roque looks for evidence on every pass.",
      );
      orders.refresh();
      // The vault now holds this order's money, so the panels that show a
      // balance need to catch up rather than wait for their next tick.
      refreshAll();
    } catch (err) {
      toast.dismiss(pending);
      toast.error("It would not arm", (err as Error).message);
      orders.refresh();
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
      toast.info("Called off", "Nothing will fill from that one, and its money is free again.");
      orders.refresh();
      refreshAll();
    } catch (err) {
      toast.error("Could not cancel it", (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const rows = orders.data ?? [];
  const watching = rows.filter((o) => o.status === "armed" || o.status === "firing").length;
  const shown = filterEventOrders(rows, group, period);

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

      <VaultFundedNotice what="Event orders" />

      {live ? (
        <>
          <EventOrderComposer onCreated={() => orders.refresh()} />

          {orders.error ? <p className="events-error">{orders.error}</p> : null}

          <EventOrderFilter
            orders={rows}
            group={group}
            period={period}
            onGroup={setGroup}
            onPeriod={setPeriod}
          />

          {rows.length === 0 && !orders.loading ? (
            <section className="card events-empty">
              <Radar size={26} />
              <p>
                Nothing on the watch list yet. Write a sentence above and screen it; the refusals are
                worth seeing too.
              </p>
            </section>
          ) : shown.length === 0 ? (
            /* Orders exist, just none in this corner of them. Say which corner,
               so the filter never reads as an empty account. */
            <section className="card events-empty">
              <Radar size={26} />
              <p>
                None of your {rows.length} event order{rows.length === 1 ? "" : "s"} match this
                filter. Widen the status or the period to see the rest.
              </p>
            </section>
          ) : (
            <div className="events-list">
              {shown.map((o) => (
                <EventOrderCard
                  key={o.id}
                  order={o}
                  onScreen={(id) => void screen(id)}
                  onArm={(id) => void arm(id)}
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
