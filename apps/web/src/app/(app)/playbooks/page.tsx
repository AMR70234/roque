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
import { usePoll } from "@/lib/hooks";
import { api } from "@/lib/api";
import { useToast } from "@/components/Toaster";
import { PrivateGate } from "@/components/PrivateGate";
import { PlaybookBuilder } from "@/components/PlaybookBuilder";
import { PlaybookCard } from "@/components/PlaybookCard";
import type { Playbook } from "@/lib/types";

const POLL_MS = 15_000;

export default function PlaybooksPage() {
  const { address, wallet, sessionReady, refreshAll } = useAppData();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);

  const live = address && sessionReady;
  const books = usePoll<Playbook[]>(
    live
      ? async () => {
          const { client } = await wallet.getClient();
          const res = await api.playbooks(address, client);
          return res.playbooks;
        }
      : null,
    POLL_MS,
    [address, sessionReady],
  );

  const arm = async (id: string) => {
    if (!address) return;
    setBusy(id);
    const pending = toast.push({
      kind: "pending",
      title: "Arming the playbook",
      detail: "Every event step is screened first. That is a consensus round each, so give it a moment.",
    });
    try {
      const { client } = await wallet.getClient();
      await api.armPlaybook(id, address, client);
      toast.dismiss(pending);
      toast.success("Running", "The keeper walks it from step one.");
      books.refresh();
    } catch (err) {
      toast.dismiss(pending);
      // Arming refuses with the offending steps named, which is worth reading in full.
      toast.error("It would not arm", (err as Error).message);
      books.refresh();
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
      toast.error("Could not stop it", (err as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const rows = books.data ?? [];
  const running = rows.filter((p) => p.status === "armed").length;

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

      {live ? (
        <>
          <PlaybookBuilder onCreated={() => books.refresh()} />

          {books.error ? <p className="events-error">{books.error}</p> : null}

          {rows.length === 0 && !books.loading ? (
            <section className="card events-empty">
              <ListOrdered size={26} />
              <p>No playbooks yet. A dip ladder is a good first one: buy a slice at each level down.</p>
            </section>
          ) : (
            <div className="events-list">
              {rows.map((p) => (
                <PlaybookCard
                  key={p.id}
                  playbook={p}
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
