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
import type { EventOrder } from "@/lib/types";
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
   * How long to keep watching work that outlived its request, and how often to
   * look. A consensus round measures 23-68s and the judgment loop retries a
   * stranded screen within five minutes, so six minutes covers both the slow
   * tail and one pass of that fallback. Arming is a Sepolia transaction behind
   * a single-file nonce queue: a shorter wait, but with no worker behind it to
   * finish the job, so it gets a window of its own.
   */
  const SCREEN_WATCH_MS = 6 * 60 * 1000;
  const ARM_WATCH_MS = 3 * 60 * 1000;
  const WATCH_POLL_MS = 5_000;

  /**
   * Poll this user's orders until `settled` accepts the row, and hand it back.
   * Null means the window elapsed without an answer, which is a thing to say
   * plainly rather than an error.
   *
   * Reading the row instead of the response is the point of this. Screening and
   * arming both outlive their own request often enough to matter, and a request
   * that died tells us nothing at all about what the work went on to do.
   */
  const awaitOrder = async (
    id: string,
    windowMs: number,
    settled: (order: EventOrder) => boolean,
  ): Promise<EventOrder | null> => {
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, WATCH_POLL_MS));
      if (!address) return null;
      try {
        const { client } = await wallet.getClient();
        const { orders: rows } = await api.eventOrders(address, client);
        const row = rows.find((o) => o.id === id);
        // A row missing from one response is not an answer. Wait for the next.
        if (!row) continue;
        if (settled(row)) return row;
      } catch {
        // A poll that fails is not news. The next one is five seconds away.
      }
    }
    return null;
  };

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
    const row = await awaitOrder(id, SCREEN_WATCH_MS, (o) => o.status !== "screening");
    orders.refresh();
    if (row) {
      report(row.status, row.screenReason);
      return;
    }
    toast.info(
      "Still with the validators",
      "The round is taking longer than usual. It keeps running without you, and the order updates itself the moment there is a verdict.",
    );
  };

  /**
   * Report what arming did, once the row says so.
   *
   * Arming is the other call here that outlives its request, and it used to be
   * reported as a refusal when it did: "It would not arm", for a transaction
   * that was very likely on its way. Worse, the status moves to 'armed' before
   * the on-chain hold is written, so a request that died mid-flight could leave
   * a person told it had failed while the money was being set aside.
   *
   * So the row is asked instead. The two outcomes worth waiting for are 'armed'
   * and a rollback to 'screened' carrying the contract's reason. `priorError` is
   * whatever the row already held when the button was pressed, so a stale reason
   * from an earlier attempt is never read as this attempt's answer.
   */
  const watchArm = async (id: string, priorError: string | null): Promise<void> => {
    const row = await awaitOrder(
      id,
      ARM_WATCH_MS,
      (o) => o.status === "armed" || (Boolean(o.error) && o.error !== priorError),
    );
    orders.refresh();
    // A hold moves the vault's committed half either way, so the panels showing
    // a balance catch up now rather than on their next tick.
    refreshAll();
    if (row?.status === "armed") {
      toast.success(
        "Armed and watching",
        "The vault is holding this order's money now, so nothing else can spend it. Roque looks for evidence on every pass.",
      );
      return;
    }
    if (row?.error) {
      toast.error("The hold did not land", row.error);
      return;
    }
    toast.info(
      "Still waiting on the chain",
      "The transaction has not reported back yet. It is not lost, and the card and the vault panel both update themselves the moment it lands.",
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
    // Read before the press, so a reason left by an earlier attempt cannot be
    // mistaken for this one's answer if the request outlives its function.
    const priorError = orders.data?.find((o) => o.id === id)?.error ?? null;
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
      if (err instanceof StillWorkingError) {
        // Not a refusal. The hold is a transaction and the request simply ran
        // out before it reported back, so the only honest thing is to wait.
        toast.info(
          "Still arming",
          "Setting the money aside outlasted the request. The transaction carries on without it, so this is a wait rather than a refusal.",
        );
        await watchArm(id, priorError);
      } else {
        toast.error("It would not arm", (err as Error).message);
        orders.refresh();
        refreshAll();
      }
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
      if (err instanceof StillWorkingError) {
        // The row is cancelled before the on-chain release is sent, so a
        // timeout here means it is called off and only the freeing of the hold
        // is still in flight. Releasing derives its own ids and anyone may do
        // it once the hold lapses, so there is nothing here to retry.
        toast.info(
          "Called off, freeing the money",
          "The order is cancelled. Releasing its hold is a transaction and outlasted the request; the vault panel updates itself when it lands.",
        );
        orders.refresh();
        refreshAll();
      } else {
        toast.error("Could not cancel it", (err as Error).message);
      }
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
