"use client";

/**
 * Playbooks: the screen where a plan stops living in your head. Write the ladder
 * at the top, and everything already running lists below with the keeper's place
 * in it marked. Arming is the moment it becomes real, and arming is also when
 * every event step gets screened, so a refusal names the step that failed rather
 * than quietly dropping it.
 */

import { useState } from "react";
import { ListOrdered, RefreshCw } from "lucide-react";
import { useAppData } from "@/providers/AppData";
import type { Playbook } from "@/lib/types";
import { api, StillWorkingError } from "@/lib/api";
import { useToast } from "@/components/Toaster";
import { PrivateGate } from "@/components/PrivateGate";
import { VaultFundedNotice } from "@/components/VaultFundedNotice";
import { PlaybookBuilder } from "@/components/PlaybookBuilder";
import { PlaybookCard } from "@/components/PlaybookCard";
import {
  PlaybookFilter,
  filterPlaybooks,
  type PlaybookGroup,
  type PlaybookPeriod,
} from "@/components/PlaybookFilter";

export default function PlaybooksPage() {
  // Shared poll, for the same reason the events screen uses one: the inbox chat
  // reads these rows too, and one list should not be fetched twice.
  const { address, wallet, sessionReady, refreshAll, playbooks: books } = useAppData();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  // The draft loaded into the builder, by id. Held as an id rather than the row
  // so the shared poll's next refresh feeds the builder current steps instead of
  // a snapshot taken when Edit was pressed.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [group, setGroup] = useState<PlaybookGroup>("all");
  const [period, setPeriod] = useState<PlaybookPeriod>("all");

  const live = address && sessionReady;

  /**
   * How long to wait on an arming that outlived its request, and how often to
   * look. Arming screens every event step at 23-68s a consensus round and then
   * writes the on-chain holds, so a plan with two event steps genuinely takes
   * minutes. There is no worker behind this to finish the job, which is why the
   * window is generous: it is the only thing watching.
   */
  const ARM_WATCH_MS = 6 * 60 * 1000;
  const ARM_POLL_MS = 5_000;

  /** What arming settled on, once the plan says. Null if the window elapsed. */
  const awaitArm = async (id: string, priorError: string | null): Promise<Playbook | null> => {
    const deadline = Date.now() + ARM_WATCH_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, ARM_POLL_MS));
      if (!address) return null;
      try {
        const { client } = await wallet.getClient();
        const { playbooks: rows } = await api.playbooks(address, client);
        const row = rows.find((p) => p.id === id);
        // A row missing from one response is not an answer. Wait for the next.
        if (!row) continue;
        if (row.status === "armed") return row;
        // A refusal leaves its reason on the plan: the unverifiable step, or the
        // contract's own words after a hold was rolled back. `priorError` is
        // what the row already carried when the button was pressed, so a stale
        // reason is never read as this attempt's answer.
        if (row.error && row.error !== priorError) return row;
      } catch {
        // A poll that fails is not news. The next one is five seconds away.
      }
    }
    return null;
  };

  /**
   * Report what arming did by asking the plan, not the request.
   *
   * This is the flow the long cap was raised for: every event step is a
   * consensus round and the holds are a transaction after them, so arming is the
   * most likely call in the app to outlive its own function. Reporting that as
   * "It would not arm" was wrong twice over, because the status moves to 'armed'
   * before the holds are written, so a request that died mid-flight could say it
   * had failed while the money was being set aside against the rungs.
   */
  const watchArm = async (id: string, priorError: string | null): Promise<void> => {
    const row = await awaitArm(id, priorError);
    books.refresh();
    // The holds move the vault's committed half, so the balance panels catch up
    // now rather than on their next tick.
    refreshAll();
    if (row?.status === "armed") {
      setEditingId((current) => (current === id ? null : current));
      toast.success(
        "Running",
        "The keeper walks it from step one. Each rung's money is held in the vault until that rung trades.",
      );
      return;
    }
    if (row?.error) {
      toast.error("It would not arm", row.error);
      return;
    }
    toast.info(
      "Still arming",
      "Screening every step and writing the holds is taking longer than one request can stay open. It carries on without you, and the card updates itself the moment it settles.",
    );
  };

  const arm = async (id: string) => {
    if (!address) return;
    setBusy(id);
    // Read before the press, so a reason left by an earlier attempt cannot be
    // mistaken for this one's answer if the request outlives its function.
    const priorError = books.data?.find((p) => p.id === id)?.error ?? null;
    const pending = toast.push({
      kind: "pending",
      title: "Arming the playbook",
      detail:
        "Every event step is screened first, and then the money each rung needs is set aside in the vault contract. That is a consensus round per step and a transaction at the end, so give it a moment.",
    });
    try {
      const { client } = await wallet.getClient();
      await api.armPlaybook(id, address, client);
      toast.dismiss(pending);
      toast.success(
        "Running",
        "The keeper walks it from step one. Each rung's money is held in the vault until that rung trades.",
      );
      // It is not a draft any more, so it is not editable any more.
      setEditingId((current) => (current === id ? null : current));
      books.refresh();
    } catch (err) {
      toast.dismiss(pending);
      if (err instanceof StillWorkingError) {
        // Not a refusal. A round per event step plus the holds is simply more
        // than one request can stay open for, so wait the work out.
        toast.info(
          "Still arming",
          "A consensus round per step and then the holds outlasted the request. The work carries on without it, so this is a wait rather than a refusal.",
        );
        await watchArm(id, priorError);
      } else {
        // Arming refuses with the offending steps named, which is worth reading in full.
        toast.error("It would not arm", (err as Error).message);
        books.refresh();
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
      await api.cancelPlaybook(id, address, client);
      toast.info("Stopped", "No further steps will fire.");
      books.refresh();
      refreshAll();
    } catch (err) {
      if (err instanceof StillWorkingError) {
        // Same shape as an event order: the plan is stopped before the releases
        // are sent, so this is the holds still being freed rather than a plan
        // that is somehow still running.
        toast.info(
          "Stopped, freeing the money",
          "No further steps will fire. Releasing the rungs' holds is a transaction and outlasted the request; the vault panel updates itself when it lands.",
        );
        books.refresh();
        refreshAll();
      } else {
        toast.error("Could not stop it", (err as Error).message);
      }
    } finally {
      setBusy(null);
    }
  };

  const rows = books.data ?? [];
  // Resolved from the current rows, so the builder follows the row rather than a
  // copy of it. A draft that stops being a draft stops being editable, which is
  // what happens when another tab arms it mid-edit.
  const editing = rows.find((p) => p.id === editingId && p.status === "draft") ?? null;

  /**
   * Load a draft into the builder and put the builder where the person is
   * looking. Without the scroll the Edit button appears to do nothing: the form
   * is above the list and on a long list it is well off screen.
   */
  const edit = (playbook: Playbook) => {
    setEditingId(playbook.id);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  };
  const running = rows.filter((p) => p.status === "armed").length;
  const shown = filterPlaybooks(rows, group, period);

  return (
    <div className="events-screen">
      <section className="events-hero">
        <div>
          <h1 className="events-title">Playbooks</h1>
          <p className="events-sub">
            One trade is a decision. A playbook is a plan: a short ladder of steps, each waiting on a
            price, an event or a clock, walked strictly in order. You write it once and Roque holds
            the discipline you would not at three in the morning.
          </p>
        </div>
        {live ? (
          <div className="events-hero-side">
            <span className="events-count">
              <ListOrdered size={14} />
              {running} running
            </span>
            <button className="btn btn-ghost btn-sm" onClick={() => books.refresh()}>
              <RefreshCw size={13} className={books.loading ? "is-spinning" : ""} />
              Refresh
            </button>
          </div>
        ) : null}
      </section>

      <PrivateGate what="Playbooks" />

      <VaultFundedNotice what="Playbook steps" />

      {live ? (
        <>
          <PlaybookBuilder
            editing={editing}
            onCancelEdit={() => setEditingId(null)}
            onCreated={() => books.refresh()}
          />

          {books.error ? <p className="events-error">{books.error}</p> : null}

          <PlaybookFilter
            books={rows}
            group={group}
            period={period}
            onGroup={setGroup}
            onPeriod={setPeriod}
          />

          {rows.length === 0 && !books.loading ? (
            <section className="card events-empty">
              <ListOrdered size={26} />
              <p>No playbooks yet. A dip ladder is a good first one: buy a slice at each level down.</p>
            </section>
          ) : shown.length === 0 ? (
            /* Plans exist, just none in this corner of them. Name the corner,
               so a narrow filter never reads as an empty account. */
            <section className="card events-empty">
              <ListOrdered size={26} />
              <p>
                None of your {rows.length} playbook{rows.length === 1 ? "" : "s"} match this filter.
                Widen the status or the period to see the rest.
              </p>
            </section>
          ) : (
            <div className="events-list">
              {shown.map((p) => (
                <PlaybookCard
                  key={p.id}
                  playbook={p}
                  onArm={(id) => void arm(id)}
                  onEdit={edit}
                  onCancel={(id) => void cancel(id)}
                  busy={busy}
                  editing={editingId === p.id}
                />
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
