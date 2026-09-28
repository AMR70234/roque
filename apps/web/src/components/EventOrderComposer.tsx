"use client";

/**
 * Where an event order gets written. The condition is a plain sentence, because
 * that is the whole pitch: describe the world you are trading against and let the
 * validators work out whether they can check it.
 *
 * The form says out loud that the sentence will be screened, and the examples are
 * split into ones that pass and one that cannot, so the rule is learned here
 * rather than discovered as a refusal.
 *
 * The size is checked against the vault as it is typed, for the same reason. An
 * order the vault cannot pay for is not an order, so the button goes unavailable
 * and says what is missing rather than accepting the click and refusing it after.
 */

import { useState } from "react";
import { Sparkles, Wand2 } from "lucide-react";
import { tokenList } from "@roque/shared";
import { useAppData } from "@/providers/AppData";
import { useToast } from "./Toaster";
import { api } from "@/lib/api";
import { vaultShortfall } from "@/lib/funding";
import type { EventOrder } from "@/lib/types";

const GOOD = [
  "Bitcoin trades above $150,000 on any major exchange",
  "The US Federal Reserve cuts its policy rate at its next meeting",
  "Ethereum's next mainnet upgrade ships to mainnet",
];
const BAD = "my neighbour's cat comes home";

export function EventOrderComposer({ onCreated }: { onCreated: (order: EventOrder) => void }) {
  const { address, wallet, slippageBps, canAutonomous, vault } = useAppData();
  const toast = useToast();
  const [condition, setCondition] = useState("");
  const [tokenIn, setTokenIn] = useState("rUSDC");
  const [tokenOut, setTokenOut] = useState("rWETH");
  const [amount, setAmount] = useState("100");
  const [isPercent, setIsPercent] = useState(false);
  const [days, setDays] = useState(14);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!address) {
      toast.info("Connect a wallet first", "An event order spends from your vault when it fires.");
      return;
    }
    setBusy(true);
    try {
      const { client } = await wallet.getClient();
      const res = await api.createEventOrder(
        {
          user: address,
          condition: condition.trim(),
          tokenIn,
          tokenOut,
          amount,
          amountIsPercent: isPercent,
          slippageBps,
          expiresInDays: days,
        },
        client,
      );
      setCondition("");
      onCreated(res.order);
      toast.success("Written down", "Now screen it, so we know the validators can check it.");
    } catch (err) {
      toast.error("Could not write that order", (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const written = condition.trim().length >= 12 && tokenIn !== tokenOut && Number(amount) > 0;
  // The vault is the only money this order can ever spend, so a size it cannot
  // cover is refused here as well as on the server.
  const shortfall = written
    ? vaultShortfall(
        [{ tokenIn, tokenOut, amount, amountIsPercent: isPercent, where: "This order" }],
        vault.data?.raw,
      )
    : null;
  const ready = written && !shortfall;

  return (
    <section className="card event-composer">
      <header className="event-composer-head">
        <Wand2 size={16} />
        <div>
          <h2 className="panel-title">Trade against the world</h2>
          <p className="event-composer-sub">
            Write the event in a sentence. Roque asks the GenLayer validators whether that sentence
            can be checked against public evidence at all, and refuses it if it cannot, so nothing
            sits here pretending it might fill.
          </p>
        </div>
      </header>

      <label className="event-field">
        <span className="event-field-label">If this happens</span>
        <textarea
          className="event-textarea"
          rows={2}
          value={condition}
          placeholder="Bitcoin trades above $150,000 on any major exchange"
          onChange={(e) => setCondition(e.target.value)}
        />
      </label>

      <div className="event-examples">
        {GOOD.map((g) => (
          <button key={g} type="button" className="suggest-chip" onClick={() => setCondition(g)}>
            {g}
          </button>
        ))}
        <button
          type="button"
          className="suggest-chip is-bad"
          onClick={() => setCondition(BAD)}
          title="This one gets refused, on purpose"
        >
          {BAD}
        </button>
      </div>

      <div className="event-trade-row">
        <span className="event-field-label">then swap</span>
        <input
          className="event-amount"
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/gu, ""))}
          inputMode="decimal"
          aria-label="Amount"
        />
        <div className="vault-denom" role="group" aria-label="Amount unit">
          <button
            type="button"
            className={`vault-denom-btn ${!isPercent ? "is-active" : ""}`}
            onClick={() => setIsPercent(false)}
          >
            tokens
          </button>
          <button
            type="button"
            className={`vault-denom-btn ${isPercent ? "is-active" : ""}`}
            onClick={() => setIsPercent(true)}
          >
            %
          </button>
        </div>
        <select
          className="token-select"
          value={tokenIn}
          onChange={(e) => setTokenIn(e.target.value)}
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
          value={tokenOut}
          onChange={(e) => setTokenOut(e.target.value)}
          aria-label="Token to buy"
        >
          {tokenList.map((t) => (
            <option key={t.symbol} value={t.symbol}>
              {t.symbol}
            </option>
          ))}
        </select>
      </div>

      <div className="event-composer-foot">
        <label className="event-expiry-pick">
          <span className="event-field-label">Give up after</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="token-select">
            {[1, 3, 7, 14, 30, 90].map((d) => (
              <option key={d} value={d}>
                {d} day{d === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </label>
        <span className="event-foot-spacer" />
        {shortfall ? (
          <span className="event-composer-warn is-refusal">{shortfall}</span>
        ) : !canAutonomous && address ? (
          <span className="event-composer-warn">
            Grant Roque a trading limit on the autonomous screen before this can fill.
          </span>
        ) : null}
        <button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !ready}>
          {busy ? <span className="spinner" /> : <Sparkles size={15} />}
          Write the order
        </button>
      </div>
    </section>
  );
}
