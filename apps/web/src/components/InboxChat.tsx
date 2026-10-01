"use client";

/**
 * A small read-only chat under the inbox. It answers questions about things the
 * app already has in hand: live prices, your balances, your vault, your recent
 * trades, your open orders, and the two judgment surfaces — the event orders you
 * are watching and the playbooks the keeper is walking. It never suggests a trade
 * and never calls the agent, so there is nothing here that can sign or spend.
 * Anything that asks for advice or a prediction gets a plain refusal instead of
 * an opinion.
 *
 * Every answer is still assembled here from data already polled, with no round
 * trip: a question is matched against the patterns below and answered from the
 * shared store. That is the whole design, and the reason the reply is instant.
 * The event and playbook rows come from `AppData` for the same reason the prices
 * do — their own screens already poll them, so the chat reads the same copy
 * rather than opening its own.
 */

import { useEffect, useRef, useState } from "react";
import { ArrowUp, MessageCircle, Trash2 } from "lucide-react";
import { tokenList } from "@roque/shared";
import { useAppData } from "@/providers/AppData";
import { formatAmount, formatUsd, formatPrice, timeUntil } from "@/lib/format";

type Line = { id: number; from: "you" | "roque"; text: string };
type Row = { symbol: string; amount: number; usd: number };

const STORAGE_KEY = "roque-inbox-chat";

const THANKS = /^\s*(thanks|thank you|thx|ty|cheers)( a lot| so much)?[\s!.]*$/i;
const GREETING =
  /^\s*(hi|hey|hello|yo|sup|howdy|gm|gn|good (morning|afternoon|evening|night)|what'?s up|whats up)( there| roque| bro| man| all| everyone)?[\s!.,?]*$/i;

const ADVICE = new RegExp(
  [
    "\\bshould i\\b",
    "\\bshall i\\b",
    "\\bgood time\\b",
    "\\bright time\\b",
    "\\bworth (buying|selling|holding)\\b",
    "\\bis it (a good|safe|smart|wise)\\b",
    "\\b(buy|sell|hold) (it )?(now|today)\\b",
    "\\bbuy or sell\\b",
    "\\bhold or sell\\b",
    "\\bwhat do you think\\b",
    "\\bwhat should i\\b",
    "\\bwill (it|eth|btc|the price|the market)\\b",
    "\\b(going|go|gonna) (up|down|to moon)\\b",
    "\\b(predict|prediction|forecast|recommend|recommendation|advice|advise|tip|tips|signal|signals)\\b",
    "\\b(bullish|bearish|moon|crash|pump|dump)\\b",
    "\\bbest (token|coin|asset|trade|investment)\\b",
    "\\b(which|what) (token|coin|asset) (should|to) (buy|sell|hold)\\b",
  ].join("|"),
  "i",
);

const HELP = /\b(help|what can you (do|answer|tell)|commands?|how does this work|examples?|options)\b/i;
const HISTORY =
  /\b(price history|chart|graph|trend|trending|gainers?|losers?|percent change|24h|24 hours|7d|this week|this month|last week|last month|yesterday|volatility)\b/i;
const EXPENSIVE =
  /\b(most expensive|priciest|highest[- ]priced?|highest price|least expensive|cheapest|lowest[- ]priced?|lowest price)\b/i;
const BIGGEST =
  /\b(biggest|largest|top|main)\b.*\b(holding|position|bag|asset|token|coin)s?\b|\bwhat do i (hold|own|have) (the )?most\b|\bmost of\b/i;
const SMALLEST =
  /\b(smallest|lowest|least)\b.*\b(holding|position|asset|token|coin)s?\b|\bwhat do i (hold|own|have) (the )?least\b/i;
const BREAKDOWN = /\b(breakdown|allocation|distribution|split|composition|diversification|diversified)\b/i;
// Tested ahead of ORDERS on purpose: "event orders" contains "orders", so the
// looser pattern would answer an event question with the limit-order list.
const EVENTS =
  /\b(event|events|event orders?|condition|conditions|watching|watch list|watchlist)\b/i;
const PLAYBOOKS = /\b(playbook|playbooks|plan|plans|ladder|steps?)\b/i;
const PROPOSALS = /\b(proposals?|inbox|suggestions?)\b/i;
const EXPIRY = /\b(expir\w*|run out|running out|lapse|deadline|how long)\b/i;
const ORDERS = /\borders?\b/i;
const TRADES = /\b(trade|trades|activity|history|recent)\b/i;
const HOLD = /\b(do i|i have|i hold|i own|my|mine|balance)\b/i;
const BALANCE =
  /\b(balance|balances|wallet|holdings?|what do i (have|hold|own)|how much do i (have|hold|own)|my (tokens|coins|assets|funds|money)|do i (have|hold|own))\b/i;
const PORTFOLIO = /\b(portfolio|net worth|worth|total|value)\b/i;
const MARKET = /\b(price|prices|market|how much is)\b/i;

const NO_WALLET = "I cannot see your wallet yet. Connect one and try again.";
const REFUSAL = "I can show you prices and what you hold, but I will not tell you what to do with them.";
const HINT =
  "Ask me about prices, your wallet, your vault, your open orders, your recent trades, your event orders or your playbooks. For example: \"price of ETH\", \"what am I watching\" or \"what is my portfolio worth\".";
const HELP_TEXT =
  "I can answer: a token's price (\"price of btc\"), a comparison (\"eth vs btc\"), the most or least expensive token, your wallet balances and total, your biggest or smallest holding, your allocation breakdown, your vault, your open orders, your recent trades, the event orders you are watching (\"what am I watching\", \"when does my event order expire\"), your playbooks and the step each one is on, and what is waiting in your inbox. I do not give trading advice.";

// Extra names people use for a token, on top of its symbol with and without the r.
const ALIASES: Record<string, string[]> = {
  rWETH: ["eth", "ether", "ethereum"],
  rWBTC: ["btc", "bitcoin"],
  rPAXG: ["gold"],
  rLINK: ["chainlink"],
  rSNX: ["synthetix"],
  rFORTH: ["ampleforth"],
  rEURC: ["euro"],
  rUSDT: ["tether"],
};

/** Every token the message names, in the order it names them. */
function findTokens(text: string): string[] {
  const lower = text.toLowerCase();
  const hits: { symbol: string; at: number }[] = [];
  for (const t of tokenList) {
    const names = [
      t.symbol.toLowerCase(),
      t.symbol.replace(/^r/u, "").toLowerCase(),
      ...(ALIASES[t.symbol] ?? []),
    ];
    for (const name of names) {
      const m = new RegExp(`\\b${name}\\b`, "u").exec(lower);
      if (m) hits.push({ symbol: t.symbol, at: m.index });
    }
  }
  hits.sort((a, b) => a.at - b.at);
  const out: string[] = [];
  for (const h of hits) if (!out.includes(h.symbol)) out.push(h.symbol);
  return out;
}

/** If a value is a token contract address, return its symbol; otherwise leave it as is. */
function symbolOf(addressOrSymbol: string): string {
  const lower = addressOrSymbol.toLowerCase();
  const match = tokenList.find((t) => t.address.toLowerCase() === lower);
  return match ? match.symbol : addressOrSymbol;
}

const sum = (rows: Row[]) => rows.reduce((s, r) => s + r.usd, 0);

export function InboxChat() {
  const { prices, ethUsd, balances, vault, activity, orders, eventOrders, playbooks, proposals } =
    useAppData();
  const [lines, setLines] = useState<Line[]>([]);
  const [value, setValue] = useState("");
  const idRef = useRef(0);
  // Remembers the last token a question named, so a short follow-up like
  // "what about btc" or "and eth" can be read without repeating the subject.
  const lastTokenRef = useRef<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  // Set on the first paint of a restored conversation, so coming back to the tab
  // lands at the bottom without animating through a fortnight of history.
  const jumpedRef = useRef(false);

  // Restore the conversation once on mount, so switching tabs and coming back
  // does not lose it. The component's own state resets on unmount; the saved
  // copy in storage is what survives that.
  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Line[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        setLines(parsed);
        idRef.current = Math.max(...parsed.map((l) => l.id));
      }
    } catch {
      // A bad or blocked store just means the chat starts empty.
    }
  }, []);

  // Persist after every change, so a mid-conversation tab switch is not lost.
  useEffect(() => {
    try {
      if (lines.length > 0) {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(lines));
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // Storage full or blocked; the chat just will not survive a reload.
    }
  }, [lines]);

  // Follow the conversation. The log is its own scroll box rather than the page,
  // so this scrolls that element and never moves the page out from under someone
  // reading the inbox above it. Reply and question land in the same state update,
  // which is why one effect keyed on the whole list is enough.
  useEffect(() => {
    const log = logRef.current;
    if (!log || lines.length === 0) return;
    // The restored conversation should already be at the bottom when it appears;
    // only a new turn is worth animating.
    const behavior = jumpedRef.current ? "smooth" : "auto";
    jumpedRef.current = true;
    log.scrollTo({ top: log.scrollHeight, behavior });
  }, [lines]);

  const clear = () => {
    setLines([]);
    jumpedRef.current = false;
    try {
      window.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Nothing to clean up if storage was never reachable.
    }
  };

  const priceOf = (symbol: string): number | undefined =>
    symbol === "rWETH" && ethUsd ? ethUsd : prices[symbol];

  const toRows = (source: Record<string, number | string> | null | undefined): Row[] | null => {
    if (!source) return null;
    return tokenList
      .map((t) => {
        const amount = Number(source[t.symbol] ?? 0);
        return { symbol: t.symbol, amount, usd: amount * (priceOf(t.symbol) ?? 0) };
      })
      .filter((r) => r.amount > 0)
      .sort((x, y) => y.usd - x.usd);
  };
  const walletRows = () => toRows(balances.data);
  const vaultRows = () => toRows(vault.data?.balances);

  const priceLine = (symbol: string): string => {
    const p = priceOf(symbol);
    if (!p) return `I do not have a live price for ${symbol} right now.`;
    return `${symbol} is at $${formatPrice(p)}.`;
  };

  const holdLine = (symbol: string): string => {
    const inWallet = balances.data?.[symbol] ?? 0;
    const inVault = Number(vault.data?.balances[symbol] ?? 0);
    const p = priceOf(symbol) ?? 0;
    const parts = [`${formatAmount(inWallet)} ${symbol} in your wallet`];
    if (inVault > 0) parts.push(`${formatAmount(inVault)} in your vault`);
    const usd = p > 0 ? ` That is about ${formatUsd((inWallet + inVault) * p)} in total.` : "";
    return `You have ${parts.join(" and ")}.${usd}`;
  };

  const answer = (raw: string): string => {
    const text = raw.trim();
    const lower = text.toLowerCase();

    if (THANKS.test(text)) return "Anytime.";
    if (GREETING.test(text)) return `Hey. ${HINT}`;
    if (ADVICE.test(lower)) return REFUSAL;
    if (HELP.test(lower)) return HELP_TEXT;

    // ── The judgment surfaces ──────────────────────────────────
    // Both read the same shared rows their own screens do, so an answer here
    // and the card on /events can never disagree.

    if (EVENTS.test(lower)) {
      const list = eventOrders.data;
      if (!list) return "I cannot read your event orders yet.";
      if (list.length === 0) {
        return "You have no event orders. The events screen is where you write one.";
      }
      const armed = list.filter((o) => o.status === "armed");
      const screening = list.filter((o) => o.status === "screening");
      const ready = list.filter((o) => o.status === "screened");
      const refused = list.filter((o) => o.status === "rejected");
      const filled = list.filter((o) => o.status === "filled");

      // "When does it run out" is a different question from "what is it", so it
      // gets the deadline rather than the condition.
      if (EXPIRY.test(lower)) {
        const dated = armed.filter((o) => o.expiresAt);
        if (dated.length === 0) return "None of your live event orders carry an expiry date.";
        const lines = dated
          .slice(0, 3)
          .map((o) => `"${o.condition}" expires ${timeUntil(o.expiresAt as string)}`);
        const more = dated.length > 3 ? ` (${dated.length - 3} more not shown)` : "";
        return `${lines.join("; ")}${more}.`;
      }

      const parts: string[] = [];
      if (armed.length > 0) {
        const conditions = armed.slice(0, 3).map((o) => {
          const size = o.amountIsPercent
            ? `${o.amount}% of ${o.tokenIn}`
            : `${formatAmount(o.amount)} ${o.tokenIn}`;
          return `"${o.condition}" then ${size} to ${o.tokenOut}`;
        });
        const more = armed.length > 3 ? ` (${armed.length - 3} more not shown)` : "";
        parts.push(
          `You are watching ${armed.length} condition${armed.length === 1 ? "" : "s"}: ${conditions.join("; ")}${more}.`,
        );
      } else {
        parts.push("Nothing is armed and watching right now.");
      }
      // The refusals are the honest part of this feature, so they are counted
      // rather than quietly left out of the summary.
      const tail: string[] = [];
      if (screening.length > 0) tail.push(`${screening.length} waiting to be screened`);
      // Worth naming first among the leftovers: these are the ones blocked on
      // the person rather than on the market.
      if (ready.length > 0) tail.push(`${ready.length} cleared and waiting for you to arm`);
      if (refused.length > 0) tail.push(`${refused.length} refused as unverifiable`);
      if (filled.length > 0) tail.push(`${filled.length} already filled`);
      if (tail.length > 0) parts.push(`Also ${tail.join(", ")}.`);
      return parts.join(" ");
    }

    if (PLAYBOOKS.test(lower)) {
      const list = playbooks.data;
      if (!list) return "I cannot read your playbooks yet.";
      if (list.length === 0) {
        return "You have no playbooks. The playbooks screen is where you write one.";
      }
      const armed = list.filter((p) => p.status === "armed");
      const drafts = list.filter((p) => p.status === "draft");
      const done = list.filter((p) => p.status === "completed");
      if (armed.length === 0) {
        const bits = [
          drafts.length > 0 ? `${drafts.length} draft${drafts.length === 1 ? "" : "s"}` : null,
          done.length > 0 ? `${done.length} completed` : null,
        ].filter((b): b is string => b !== null);
        return bits.length > 0
          ? `Nothing is running. You have ${bits.join(" and ")}.`
          : "None of your playbooks are running.";
      }
      const lines = armed.slice(0, 3).map((p) => {
        const total = p.steps.length;
        // The cursor is zero-based; a person counts steps from one.
        const at = Math.min(p.stepCursor + 1, total);
        return `"${p.name}" is on step ${at} of ${total}`;
      });
      const more = armed.length > 3 ? ` (${armed.length - 3} more not shown)` : "";
      const draftPart =
        drafts.length > 0
          ? ` You also have ${drafts.length} draft${drafts.length === 1 ? "" : "s"} not yet armed.`
          : "";
      return `${lines.join("; ")}${more}.${draftPart}`;
    }

    if (PROPOSALS.test(lower)) {
      const list = proposals.data;
      if (!list) return "I cannot read your inbox yet.";
      const open = list.filter((p) => p.status === "new");
      if (open.length === 0) return "Nothing is waiting in your inbox.";
      const titles = open.slice(0, 3).map((p) => p.title);
      const more = open.length > 3 ? ` (${open.length - 3} more not shown)` : "";
      return `You have ${open.length} proposal${open.length === 1 ? "" : "s"} waiting: ${titles.join("; ")}${more}.`;
    }

    if (ORDERS.test(lower)) {
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
      const rows = vaultRows();
      if (!rows) return "I cannot read your vault yet.";
      if (rows.length === 0) return "Your vault is empty.";
      return `In your vault: ${rows.map((r) => `${formatAmount(r.amount)} ${r.symbol}`).join(", ")}. That is about ${formatUsd(sum(rows))}.`;
    }

    if (EXPENSIVE.test(lower)) {
      const cheap = /\b(cheapest|least expensive|lowest)/u.test(lower);
      const ranked = tokenList
        .map((t) => ({ s: t.symbol, p: priceOf(t.symbol) }))
        .filter((r): r is { s: string; p: number } => typeof r.p === "number" && r.p > 0)
        .sort((a, b) => (cheap ? a.p - b.p : b.p - a.p));
      if (ranked.length === 0) return "I do not have live prices right now.";
      const list = ranked.slice(0, 3).map((r) => `${r.s} ($${formatPrice(r.p)})`);
      return `The ${cheap ? "cheapest" : "most expensive"} tokens right now: ${list.join(", ")}.`;
    }

    if (SMALLEST.test(lower) || BIGGEST.test(lower) || BREAKDOWN.test(lower)) {
      const rows = walletRows();
      if (!rows) return NO_WALLET;
      const top = rows[0];
      const bottom = rows[rows.length - 1];
      if (!top || !bottom) return "Your wallet is empty.";
      const total = sum(rows);
      const pct = (r: Row) => (total > 0 ? ((r.usd / total) * 100).toFixed(1) : "0.0");
      if (SMALLEST.test(lower)) {
        return `Your smallest holding is ${bottom.symbol}, about ${formatUsd(bottom.usd)}, which is ${pct(bottom)}% of your wallet.`;
      }
      if (BIGGEST.test(lower)) {
        return `Your biggest holding is ${top.symbol}, about ${formatUsd(top.usd)}, which is ${pct(top)}% of your wallet.`;
      }
      const shown = rows.slice(0, 5).map((r) => `${r.symbol} ${pct(r)}%`).join(", ");
      const more = rows.length > 5 ? ` (${rows.length - 5} smaller ones not shown)` : "";
      return `Your wallet by value: ${shown}${more}.`;
    }

    if (HISTORY.test(lower)) {
      const first = tokens0(lower);
      const now = first ? `${priceLine(first)} ` : "";
      return `${now}I only see current prices here, not how they moved over time. The View Chart button on a trade card opens the price chart.`;
    }

        if (TRADES.test(lower)) {
      const trades = activity.data?.trades ?? [];
      if (trades.length === 0) return "No settled trades on record yet.";
      const single = /\b(last|latest|most recent)\b.*\btrade\b(?!s)/u.test(lower);
      if (single) {
        const t = trades[0];
        return `Your last completed trade was ${t.amount_in} ${symbolOf(t.token_in)} to ${symbolOf(t.token_out)}.`;
      }
      const last = trades.slice(0, 3).map((t) => `${t.amount_in} ${symbolOf(t.token_in)} to ${symbolOf(t.token_out)}`);
      return `Your latest settled trades: ${last.join("; ")}.`;
    }
    
        // A short follow-up ("what about btc", "and eth", "same for gold") that
    // names a token but gives no verb of its own reuses the last question's
    // intent against the new token, instead of falling through to the hint.
    const FOLLOW_UP = /^\s*(what about|and|what'?s|how about|same for)\b/i;
    let tokens = findTokens(text);
    if (tokens.length > 0 && FOLLOW_UP.test(text) && lastTokenRef.current) {
      const t = tokens[0];
      if (t) {
        const held = balances.data?.[t];
        const own = held !== undefined && held > 0 ? ` You hold ${formatAmount(held)} in your wallet.` : "";
        lastTokenRef.current = t;
        return `${priceLine(t)}${own}`;
      }
    }
    if (tokens.length > 0) {
      const first = tokens[0];
      if (first) lastTokenRef.current = first;
      if (HOLD.test(lower)) {
        if (!balances.data) return NO_WALLET;
        return tokens.slice(0, 3).map(holdLine).join(" ");
      }
      const a = tokens[0];
      const b = tokens[1];
      if (a && b) {
        const pa = priceOf(a);
        const pb = priceOf(b);
        if (!pa || !pb) return "I do not have live prices for both of those right now.";
        return `${a} is at $${formatPrice(pa)} and ${b} is at $${formatPrice(pb)}. One ${a} is about ${formatAmount(pa / pb)} ${b}.`;
      }
      if (a) {
        const held = balances.data?.[a];
        const own = held !== undefined && held > 0 ? ` You hold ${formatAmount(held)} in your wallet.` : "";
        return `${priceLine(a)}${own}`;
      }
    }

    if (BALANCE.test(lower)) {
      const rows = walletRows();
      if (!rows) return NO_WALLET;
      if (rows.length === 0) return "Your wallet is empty.";
      const shown = rows.slice(0, 6).map((r) => `${formatAmount(r.amount)} ${r.symbol}`).join(", ");
      const more = rows.length > 6 ? `, and ${rows.length - 6} more` : "";
      return `In your wallet: ${shown}${more}. Total about ${formatUsd(sum(rows))}.`;
    }

    if (PORTFOLIO.test(lower)) {
      const rows = walletRows();
      if (!rows) return NO_WALLET;
      const inVault = vaultRows();
      const vaultPart = inVault && inVault.length > 0 ? ` Your vault holds about ${formatUsd(sum(inVault))}.` : "";
      return `Your wallet holds about ${formatUsd(sum(rows))} across all tokens.${vaultPart}`;
    }

    if (MARKET.test(lower)) {
      if (!ethUsd) return "I do not have a live price yet.";
      return `ETH is at $${formatPrice(ethUsd)}. Name a token for its price.`;
    }

    return HINT;
  };

  // Small helper used only by the history branch, kept outside `answer` so it
  // does not shadow the `tokens` used further down.
  const tokens0 = (lower: string): string | undefined => findTokens(lower)[0];

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
        {lines.length > 0 ? (
          <button className="console-clear" onClick={clear} title="Clear this conversation">
            <Trash2 size={14} />
            Clear
          </button>
        ) : null}
      </header>
      <div className="inbox-chat-log" ref={logRef}>
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