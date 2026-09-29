"use client";

/**
 * A small read-only chat under the inbox. It answers questions about things the
 * app already has in hand: live prices, your balances, your vault, your recent
 * trades. It never suggests a trade and never calls the agent, so there is
 * nothing here that can sign or spend. Anything that asks for advice gets a
 * plain refusal instead of an opinion.
 */

import { useRef, useState } from "react";
import { ArrowUp, MessageCircle } from "lucide-react";
import { tokenList } from "@roque/shared";
import { useAppData } from "@/providers/AppData";
import { formatAmount, formatUsd, formatPrice } from "@/lib/format";

type Line = { id: number; from: "you" | "roque"; text: string };

const GREETING = /^\s*(hi|hey|hello|yo|sup|hola|gm|good (morning|evening)|اهلا|أهلا|مرحبا)\b/i;
const ADVICE =
  /\b(should i|shall i|good time|worth (buying|selling)|is it a good|buy or sell|what do you think|will (it|eth|btc|the price)|predict|recommend|advice)\b/i;
const HINT =
  "Ask me about prices, your wallet, your vault, or your recent trades. For example: \"price of ETH\" or \"what is my portfolio worth\".";

/** Find a token the message names, by symbol with or without the leading r. */
function findToken(text: string): string | null {
  const lower = text.toLowerCase();
  for (const t of tokenList) {
    const bare = t.symbol.replace(/^r/u, "").toLowerCase();
    if (new RegExp(`\\b(${t.symbol.toLowerCase()}|${bare})\\b`, "u").test(lower)) return t.symbol;
  }
  if (/\b(eth|ether|ethereum)\b/u.test(lower)) return "rWETH";
  if (/\b(btc|bitcoin)\b/u.test(lower)) return "rWBTC";
  if (/\bgold\b/u.test(lower)) return "rPAXG";
  return null;
}

export function InboxChat() {
  const { prices, ethUsd, balances, vault, activity, orders } = useAppData();
  const [lines, setLines] = useState<Line[]>([]);
  const [value, setValue] = useState("");
  const idRef = useRef(0);

  const answer = (raw: string): string => {
    const text = raw.trim();
    if (GREETING.test(text) && text.length < 30) return `Hey. ${HINT}`;
    if (ADVICE.test(text)) {
      return "I can show you prices and what you hold, but I will not tell you what to do with them.";
    }

    const lower = text.toLowerCase();
    const token = findToken(text);

    if (/\b(portfolio|net worth|worth|total|holdings)\b/u.test(lower) && !token) {
      const b = balances.data;
      if (!b) return "I cannot see your wallet yet. Connect one and try again.";
      const total = tokenList.reduce((s, t) => s + (b[t.symbol] ?? 0) * (prices[t.symbol] ?? 0), 0);
      return `Your wallet holds about ${formatUsd(total)} across all tokens.`;
    }

       if (/\borders?\b/u.test(lower)) {
      const list = orders.data?.orders;
      if (!list) return "I cannot read your open orders yet.";
      const open = list.filter((o) => !o.expired);
      if (open.length === 0) return "You have no open limit orders.";
      const rows = open.slice(0, 3).map((o) => {
        const side = o.triggerAbove ? "above" : "below";
        return `${o.amountIn} ${o.tokenInSymbol} to ${o.tokenOutSymbol} when price goes ${side} $${o.triggerPrice}`;
      });
      const more = open.length > 3 ? ` (${open.length - 3} more not shown)` : "";
      return `You have ${open.length} open limit order${open.length === 1 ? "" : "s"}: ${rows.join("; ")}${more}.`;
    }

    if (/\bvault\b/u.test(lower)) {
      const v = vault.data?.balances;
      if (!v) return "I cannot read your vault yet.";
      const rows = tokenList
        .map((t) => ({ s: t.symbol, n: Number(v[t.symbol] ?? 0) }))
        .filter((r) => r.n > 0);
      if (rows.length === 0) return "Your vault is empty.";
      return `In your vault: ${rows.map((r) => `${formatAmount(r.n)} ${r.s}`).join(", ")}.`;
    }

        if (/\b(trade|trades|activity|history|recent)\b/u.test(lower)) {
      const trades = activity.data?.trades ?? [];
      if (trades.length === 0) return "No settled trades on record yet.";
      const single = /\b(last|latest|most recent)\b.*\btrade\b(?!s)/u.test(lower);
      if (single) {
        const t = trades[0];
        return `Your last completed trade was ${t.amount_in} ${t.token_in} to ${t.token_out}.`;
      }
      const last = trades.slice(0, 3).map((t) => `${t.amount_in} ${t.token_in} to ${t.token_out}`);
      return `Your latest settled trades: ${last.join("; ")}.`;
    }

    if (token) {
      const p = token === "rWETH" ? ethUsd : prices[token];
      const held = balances.data?.[token];
      if (!p) return `I do not have a live price for ${token} right now.`;
      const own = held !== undefined ? ` You hold ${formatAmount(held)} in your wallet.` : "";
      return `${token} is at $${formatPrice(p)}.${own}`;
    }

    if (/\b(price|prices|market)\b/u.test(lower)) {
      return `ETH is at $${formatPrice(ethUsd)}. Name a token for its price.`;
    }

    return HINT;
  };

  const send = () => {
    const text = value.trim();
    if (!text) return;
    setLines((l) => [
      ...l,
      { id: ++idRef.current, from: "you", text },
      { id: ++idRef.current, from: "roque", text: answer(text) },
    ]);
    setValue("");
  };

  return (
    <section className="card inbox-chat">
      <header className="panel-head">
        <h3 className="panel-title">
          <MessageCircle size={15} /> Ask about the market
        </h3>
      </header>
      <div className="inbox-chat-log">
        {lines.length === 0 ? <p className="panel-empty">{HINT}</p> : null}
        {lines.map((l) => (
          <p key={l.id} className={`inbox-chat-line inbox-chat-${l.from}`}>
            {l.text}
          </p>
        ))}
      </div>
      <div className="inbox-chat-input">
        <input
          className="inbox-chat-field"
          placeholder="Ask about a price, your wallet, your trades"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button
          className="console-send"
          onClick={send}
          disabled={value.trim().length === 0}
          aria-label="Send"
        >
          <ArrowUp size={18} />
        </button>
      </div>
    </section>
  );
}