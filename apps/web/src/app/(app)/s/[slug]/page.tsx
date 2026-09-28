"use client";

/**
 * A shared thesis, open to anyone with the link. The reasoning travels; the
 * position does not. You can read exactly what the author set up and what they
 * said about it, and you cannot see a balance, a size they actually risked, or who
 * they are beyond an address.
 *
 * Forking copies the plan into your own vault at your own size, and it lands
 * unarmed. Deciding to put money behind someone else's idea stays a separate,
 * deliberate act — which is the only reason a link like this is safe to pass around.
 *
 * The author's size says nothing about this person's vault, so a forked event
 * order is costed against it before the button will go: an event order starts
 * screening the moment it is written, and one written against money the agent
 * cannot reach would arm and then fail. A forked playbook lands as a draft, which
 * commits nothing, so that one is checked when it is armed instead.
 */

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { Eye, GitFork, Radar, ListOrdered, Quote } from "lucide-react";
import { useAppData } from "@/providers/AppData";
import { usePoll } from "@/lib/hooks";
import { api } from "@/lib/api";
import { useToast } from "@/components/Toaster";
import { shorten, timeAgo } from "@/lib/format";
import { vaultShortfall } from "@/lib/funding";
import type { EventOrderPayload, PlaybookPayload, Share } from "@/lib/types";

export default function SharePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { address, wallet, vault } = useAppData();
  const toast = useToast();
  const router = useRouter();
  const [amount, setAmount] = useState("");
  const [isPercent, setIsPercent] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  // Read once and leave it; a share is a snapshot, so there is nothing to poll for.
  const share = usePoll<Share>(async () => (await api.share(slug)).share, 600_000, [slug]);

  const fork = async () => {
    if (!address) {
      toast.info("Connect a wallet first", "A fork lands in your own vault, at your own size.");
      return;
    }
    setBusy(true);
    try {
      const { client } = await wallet.getClient();
      const res = await api.forkShare(
        {
          slug,
          user: address,
          amount: amount.trim() || undefined,
          amountIsPercent: isPercent ?? undefined,
        },
        client,
      );
      toast.success(
        "Forked, and left unarmed",
        res.kind === "event_order"
          ? "Screen it when you are ready; nothing fills before that."
          : "Arm it when you are ready; nothing fires before that.",
      );
      router.push(res.kind === "event_order" ? "/events" : "/playbooks");
    } catch (err) {
      toast.error("Could not fork that", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (share.error) {
    return (
      <div className="events-screen">
        <section className="card events-empty">
          <Radar size={26} />
          <p>{share.error}</p>
        </section>
      </div>
    );
  }

  const s = share.data;
  if (!s) {
    return (
      <div className="events-screen">
        <div className="card share-skeleton">
          <div className="skeleton" style={{ height: 20, width: "40%" }} />
          <div className="skeleton" style={{ height: 14, width: "80%" }} />
          <div className="skeleton" style={{ height: 14, width: "60%" }} />
        </div>
      </div>
    );
  }

  const isEvent = s.kind === "event_order";
  const ev = isEvent ? (s.payload as EventOrderPayload) : null;
  const pb = isEvent ? null : (s.payload as PlaybookPayload);
  const authorSize = ev
    ? ev.amountIsPercent
      ? `${ev.amount}% of their ${ev.tokenIn}`
      : `${ev.amount} ${ev.tokenIn}`
    : null;

  // A blank size means the author's, so that is what gets costed out.
  const mySize = amount.trim() || (ev ? ev.amount : "");
  const myIsPercent = isPercent ?? (ev ? ev.amountIsPercent : false);
  const shortfall =
    ev && address && Number(mySize) > 0
      ? vaultShortfall(
          [
            {
              tokenIn: ev.tokenIn,
              tokenOut: ev.tokenOut,
              amount: mySize,
              amountIsPercent: myIsPercent,
              where: "This order",
            },
          ],
          vault.data?.raw,
        )
      : null;

  return (
    <div className="events-screen share-screen">
      <section className="card share-hero">
        <span className="share-kind">
          {isEvent ? <Radar size={13} /> : <ListOrdered size={13} />}
          {isEvent ? "Event order" : "Playbook"}
        </span>
        <h1 className="share-title">{s.title}</h1>
        {s.note ? (
          <p className="share-note">
            <Quote size={13} />
            {s.note}
          </p>
        ) : null}
        <p className="share-byline">
          Shared by <span className="mono">{shorten(s.author)}</span> · {timeAgo(s.createdAt)} ·{" "}
          <Eye size={12} /> {s.views} · <GitFork size={12} /> {s.forks}
        </p>
      </section>

      <section className="card share-plan">
        <h2 className="panel-title">The plan</h2>
        <ol className="share-summary">
          {s.summary.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ol>
        {pb ? (
          <p className="share-meta-note">
            {pb.steps.length} step{pb.steps.length === 1 ? "" : "s"}, walked in order. Any event step
            is screened against public evidence when you arm it.
          </p>
        ) : null}
        {ev ? (
          <p className="share-meta-note">
            The author sized this at {authorSize}. Yours is your call, below.
          </p>
        ) : null}
      </section>

      <section className="card share-fork">
        <h2 className="panel-title">Fork it into your vault</h2>
        <p className="share-fork-body">
          This copies the thinking, not the position. It lands in your account unarmed and spends
          nothing until you arm it yourself, inside the limits you already granted Roque.
        </p>
        <div className="share-fork-row">
          <input
            className="event-amount"
            value={amount}
            inputMode="decimal"
            placeholder={ev ? `Your size (author used ${ev.amount})` : "Your size for step one"}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/gu, ""))}
            aria-label="Your size"
          />
          <div className="vault-denom" role="group" aria-label="Amount unit">
            <button
              type="button"
              className={`vault-denom-btn ${isPercent === false ? "is-active" : ""}`}
              onClick={() => setIsPercent(false)}
            >
              tokens
            </button>
            <button
              type="button"
              className={`vault-denom-btn ${isPercent === true ? "is-active" : ""}`}
              onClick={() => setIsPercent(true)}
            >
              %
            </button>
          </div>
          <button
            className="btn btn-primary"
            onClick={() => void fork()}
            disabled={busy || shortfall !== null}
            title={shortfall ?? undefined}
          >
            {busy ? <span className="spinner" /> : <GitFork size={15} />}
            Fork it
          </button>
        </div>
        {shortfall ? <p className="playbook-fund-warn">{shortfall}</p> : null}
        <p className="share-fork-hint">
          Leave the size blank to keep the author&rsquo;s, whatever that was.
        </p>
      </section>
    </div>
  );
}
