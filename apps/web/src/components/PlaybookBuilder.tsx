"use client";

/**
 * Where a plan gets written down. A playbook is a short list of steps, each one a
 * trigger and a trade, walked in order: the keeper will not look at step two until
 * step one has fired. That ordering is the whole idea, so the list is numbered and
 * you can only append and remove from the end of your thinking, not shuffle it.
 *
 * Event triggers are screened when the playbook is armed, not here, and the form
 * says so, because a step whose sentence nobody can check would stall the whole
 * plan behind it.
 *
 * Funding is checked the same way, at arm time on the server, and shown here as
 * you write. A draft is only a plan, so an unfunded one still saves; what it
 * cannot do is arm, and it is better to learn that while the size is still in
 * front of you. The ladder's own output counts: a rung that sells what the rung
 * above it bought is funded by the plan, not by the vault.
 */

import { useState } from "react";
import { Plus, Trash2, Rocket, ListOrdered } from "lucide-react";
import { tokenList } from "@roque/shared";
import { useAppData } from "@/providers/AppData";
import { useToast } from "./Toaster";
import { api } from "@/lib/api";
import { vaultShortfall } from "@/lib/funding";
import type { PlaybookTrigger } from "@/lib/types";

type Draft = {
  triggerKind: PlaybookTrigger["kind"];
  direction: "above" | "below";
  usd: string;
  condition: string;
  minutes: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  isPercent: boolean;
};

const MAX_STEPS = 10;

function blank(): Draft {
  return {
    triggerKind: "price",
    direction: "below",
    usd: "3000",
    condition: "",
    minutes: "60",
    tokenIn: "rUSDC",
    tokenOut: "rWETH",
    amount: "25",
    isPercent: true,
  };
}

function toTrigger(d: Draft): PlaybookTrigger {
  switch (d.triggerKind) {
    case "price":
      return { kind: "price", direction: d.direction, usd: Number(d.usd) };
    case "event":
      return { kind: "event", condition: d.condition.trim() };
    case "delay":
      return { kind: "delay", minutes: Number(d.minutes) };
    default:
      return { kind: "immediate" };
  }
}

function describe(d: Draft): string {
  const size = d.isPercent ? `${d.amount}% of ${d.tokenIn}` : `${d.amount} ${d.tokenIn}`;
  const trade = `swap ${size} for ${d.tokenOut}`;
  switch (d.triggerKind) {
    case "price":
      return `When ETH goes ${d.direction} $${d.usd}, ${trade}`;
    case "event":
      return `If ${d.condition || "..."}, ${trade}`;
    case "delay":
      return `${d.minutes} minutes after the step before, ${trade}`;
    default:
      return `Straight away, ${trade}`;
  }
}

export function PlaybookBuilder({ onCreated }: { onCreated: () => void }) {
  const { address, wallet, slippageBps, vault } = useAppData();
  const toast = useToast();
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [steps, setSteps] = useState<Draft[]>([blank()]);
  const [busy, setBusy] = useState(false);

  const patch = (i: number, p: Partial<Draft>) =>
    setSteps((s) => s.map((step, idx) => (idx === i ? { ...step, ...p } : step)));

  const valid = (d: Draft) => {
    if (d.tokenIn === d.tokenOut) return false;
    if (!(Number(d.amount) > 0)) return false;
    if (d.triggerKind === "price" && !(Number(d.usd) > 0)) return false;
    if (d.triggerKind === "event" && d.condition.trim().length < 12) return false;
    if (d.triggerKind === "delay" && !(Number(d.minutes) > 0)) return false;
    return true;
  };

  const ready = name.trim().length > 0 && steps.length > 0 && steps.every(valid);

  // What the vault would have to be holding for the whole ladder to run. Every
  // step is counted together, because a plan that can afford its first rung and
  // not its second is a plan that stops halfway.
  const shortfall = steps.every(valid)
    ? vaultShortfall(
        steps.map((d, i) => ({
          tokenIn: d.tokenIn,
          tokenOut: d.tokenOut,
          amount: d.amount,
          amountIsPercent: d.isPercent,
          where: `Step ${i + 1}`,
        })),
        vault.data?.availableRaw,
      )
    : null;

  const submit = async () => {
    if (!address) return;
    setBusy(true);
    try {
      const { client } = await wallet.getClient();
      await api.createPlaybook(
        {
          user: address,
          name: name.trim(),
          note: note.trim() || undefined,
          slippageBps,
          steps: steps.map((d) => ({
            label: describe(d),
            trigger: toTrigger(d),
            action: {
              tokenIn: d.tokenIn,
              tokenOut: d.tokenOut,
              amount: d.amount,
              amountIsPercent: d.isPercent,
            },
          })),
        },
        client,
      );
      setName("");
      setNote("");
      setSteps([blank()]);
      onCreated();
      toast.success("Playbook saved as a draft", "Arm it when you want the keeper walking it.");
    } catch (err) {
      toast.error("Could not save that playbook", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card playbook-builder">
      <header className="event-composer-head">
        <ListOrdered size={16} />
        <div>
          <h2 className="panel-title">Write a playbook</h2>
          <p className="event-composer-sub">
            Steps run in order. The keeper will not look at a step until the one before it has
            fired, so a ladder stays a ladder. Any event trigger gets screened when you arm it.
          </p>
        </div>
      </header>

      <div className="playbook-meta">
        <input
          className="event-amount playbook-name"
          value={name}
          placeholder="Name it: Dip ladder"
          onChange={(e) => setName(e.target.value)}
          aria-label="Playbook name"
        />
        <input
          className="event-amount playbook-note"
          value={note}
          placeholder="Optional note: why this plan"
          onChange={(e) => setNote(e.target.value)}
          aria-label="Playbook note"
        />
      </div>

      <ol className="playbook-steps">
        {steps.map((d, i) => (
          <li key={i} className={`playbook-step-draft ${valid(d) ? "" : "is-incomplete"}`}>
            <div className="playbook-step-num">{i + 1}</div>
            <div className="playbook-step-body">
              <div className="playbook-step-row">
                <select
                  className="token-select"
                  value={d.triggerKind}
                  onChange={(e) => patch(i, { triggerKind: e.target.value as Draft["triggerKind"] })}
                  aria-label="Trigger kind"
                >
                  <option value="price">When ETH price</option>
                  <option value="event">If an event happens</option>
                  <option value="delay">After a wait</option>
                  <option value="immediate">Straight away</option>
                </select>

                {d.triggerKind === "price" ? (
                  <>
                    <select
                      className="token-select"
                      value={d.direction}
                      onChange={(e) => patch(i, { direction: e.target.value as "above" | "below" })}
                      aria-label="Direction"
                    >
                      <option value="below">goes below</option>
                      <option value="above">goes above</option>
                    </select>
                    <span className="event-field-label">$</span>
                    <input
                      className="event-amount is-narrow"
                      value={d.usd}
                      inputMode="decimal"
                      onChange={(e) => patch(i, { usd: e.target.value.replace(/[^\d.]/gu, "") })}
                      aria-label="Price in dollars"
                    />
                  </>
                ) : null}

                {d.triggerKind === "delay" ? (
                  <>
                    <input
                      className="event-amount is-narrow"
                      value={d.minutes}
                      inputMode="numeric"
                      onChange={(e) => patch(i, { minutes: e.target.value.replace(/[^\d]/gu, "") })}
                      aria-label="Minutes to wait"
                    />
                    <span className="event-field-label">minutes later</span>
                  </>
                ) : null}
              </div>

              {d.triggerKind === "event" ? (
                <textarea
                  className="event-textarea"
                  rows={2}
                  value={d.condition}
                  placeholder="The Fed cuts rates at its next meeting"
                  onChange={(e) => patch(i, { condition: e.target.value })}
                  aria-label="Event condition"
                />
              ) : null}

              <div className="playbook-step-row">
                <span className="event-field-label">then swap</span>
                <input
                  className="event-amount is-narrow"
                  value={d.amount}
                  inputMode="decimal"
                  onChange={(e) => patch(i, { amount: e.target.value.replace(/[^\d.]/gu, "") })}
                  aria-label="Amount"
                />
                <div className="vault-denom" role="group" aria-label="Amount unit">
                  <button
                    type="button"
                    className={`vault-denom-btn ${!d.isPercent ? "is-active" : ""}`}
                    onClick={() => patch(i, { isPercent: false })}
                  >
                    tokens
                  </button>
                  <button
                    type="button"
                    className={`vault-denom-btn ${d.isPercent ? "is-active" : ""}`}
                    onClick={() => patch(i, { isPercent: true })}
                  >
                    %
                  </button>
                </div>
                <select
                  className="token-select"
                  value={d.tokenIn}
                  onChange={(e) => patch(i, { tokenIn: e.target.value })}
                  aria-label="Token to sell"
                >
                  {tokenList.map((t) => (
                    <option key={t.symbol} value={t.symbol}>
                      {t.symbol}
                    </option>
                  ))}
                </select>
                <span className="event-field-label">for</span>
                <select
                  className="token-select"
                  value={d.tokenOut}
                  onChange={(e) => patch(i, { tokenOut: e.target.value })}
                  aria-label="Token to buy"
                >
                  {tokenList.map((t) => (
                    <option key={t.symbol} value={t.symbol}>
                      {t.symbol}
                    </option>
                  ))}
                </select>
              </div>

              <p className="playbook-step-read">{describe(d)}</p>
            </div>

            {steps.length > 1 ? (
              <button
                type="button"
                className="playbook-step-drop"
                onClick={() => setSteps((s) => s.filter((_, idx) => idx !== i))}
                aria-label={`Remove step ${i + 1}`}
              >
                <Trash2 size={14} />
              </button>
            ) : null}
          </li>
        ))}
      </ol>

      <div className="event-composer-foot">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setSteps((s) => [...s, blank()])}
          disabled={steps.length >= MAX_STEPS}
        >
          <Plus size={14} />
          Add a step
        </button>
        <span className="event-foot-spacer" />
        {shortfall ? (
          <span className="event-composer-warn is-refusal">
            {shortfall} It saves as a draft, but it cannot be armed until then.
          </span>
        ) : null}
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !ready}>
          {busy ? <span className="spinner" /> : <Rocket size={15} />}
          Save the playbook
        </button>
      </div>
    </section>
  );
}
