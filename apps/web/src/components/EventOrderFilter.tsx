"use client";

/**
 * The watch list, narrowed. Once a few orders have been through a screen the
 * list is mostly history, and history and live work want different things: a
 * person checking on what is still watching does not want to scroll past a
 * fortnight of filled and refused orders to find it.
 *
 * Two independent narrowings, because they answer different questions. The
 * status row answers "what state is it in", and the seven statuses collapse into
 * the four a person actually thinks in. The two pre-arm states (screening and
 * refused) are one bucket, and the three ways an order ends without filling are
 * another. The period row answers "when did I write it", counted from the
 * order's own creation rather than its last update, so an order does not move
 * between buckets when the keeper looks at it.
 *
 * Every count shown is the count under the *other* filter, so the numbers on the
 * status row tell you what picking one would actually give you within the period
 * you are already in, rather than a total you cannot see.
 */

import type { EventOrder } from "@/lib/types";

export type EventGroup = "all" | "watching" | "executed" | "cancelled" | "screening";
export type EventPeriod = "all" | "24h" | "7d" | "30d";

/**
 * The buckets a person thinks in, mapped onto the statuses a row can hold.
 * `null` means every status. Annotated rather than inferred on purpose: with
 * `satisfies`, each entry keeps its own literal tuple type and the lookup below
 * widens to a union of tuples whose `includes` accepts nothing at all.
 */
export const EVENT_GROUPS: Record<EventGroup, EventOrder["status"][] | null> = {
  all: null,
  watching: ["armed", "firing"],
  executed: ["filled"],
  // Three ways an order ends without trading, which a person reads as one thing:
  // it is over and nothing happened.
  cancelled: ["cancelled", "expired", "failed"],
  // Everything before a person has armed it: waiting to be screened, cleared
  // and waiting on them, or refused.
  screening: ["screening", "screened", "rejected"],
};

/** How far back to look, in days. `null` is everything ever. */
export const EVENT_PERIODS: Record<EventPeriod, number | null> = {
  all: null,
  "24h": 1,
  "7d": 7,
  "30d": 30,
};

const GROUP_LABELS: Record<EventGroup, string> = {
  all: "All",
  watching: "Watching",
  executed: "Executed",
  cancelled: "Cancelled",
  screening: "Pre-arm",
};

const PERIOD_LABELS: Record<EventPeriod, string> = {
  all: "Any time",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

const GROUP_ORDER: EventGroup[] = ["all", "watching", "executed", "cancelled", "screening"];
const PERIOD_ORDER: EventPeriod[] = ["all", "24h", "7d", "30d"];

/** Does this order's status fall in the bucket? */
export function inGroup(order: EventOrder, group: EventGroup): boolean {
  const statuses = EVENT_GROUPS[group];
  return statuses === null || statuses.includes(order.status);
}

/**
 * Was this order written inside the window? Counted from `createdAt`, and a row
 * whose date will not parse is kept rather than hidden, because losing an order to a
 * bad timestamp is worse than showing it in the wrong bucket.
 */
export function inPeriod(order: EventOrder, period: EventPeriod, now = Date.now()): boolean {
  const days = EVENT_PERIODS[period];
  if (days === null) return true;
  const made = new Date(order.createdAt).getTime();
  if (!Number.isFinite(made)) return true;
  return made >= now - days * 86_400_000;
}

/** Both narrowings at once, in the order the list will render. */
export function filterEventOrders(
  orders: EventOrder[],
  group: EventGroup,
  period: EventPeriod,
): EventOrder[] {
  const now = Date.now();
  return orders.filter((o) => inGroup(o, group) && inPeriod(o, period, now));
}

export function EventOrderFilter({
  orders,
  group,
  period,
  onGroup,
  onPeriod,
}: {
  orders: EventOrder[];
  group: EventGroup;
  period: EventPeriod;
  onGroup: (group: EventGroup) => void;
  onPeriod: (period: EventPeriod) => void;
}) {
  // Nothing to narrow until there is more than one thing to look at.
  if (orders.length === 0) return null;

  const now = Date.now();
  // Counted against the period already chosen, so the number on a status is what
  // clicking it would really show.
  const inWindow = orders.filter((o) => inPeriod(o, period, now));
  const groupCount = (g: EventGroup) => inWindow.filter((o) => inGroup(o, g)).length;
  // And the reverse for the period row, against the status already chosen.
  const ofGroup = orders.filter((o) => inGroup(o, group));
  const periodCount = (p: EventPeriod) => ofGroup.filter((o) => inPeriod(o, p, now)).length;

  return (
    <div className="event-filter">
      <div className="event-filter-row" role="group" aria-label="Filter by status">
        {GROUP_ORDER.map((g) => {
          const count = groupCount(g);
          return (
            <button
              key={g}
              type="button"
              className={`feed-tab ${group === g ? "is-active" : ""}`}
              aria-pressed={group === g}
              onClick={() => onGroup(g)}
            >
              {GROUP_LABELS[g]}
              <span className="event-filter-count">{count}</span>
            </button>
          );
        })}
      </div>
      <div className="event-filter-row" role="group" aria-label="Filter by period">
        {PERIOD_ORDER.map((p) => (
          <button
            key={p}
            type="button"
            className={`feed-tab ${period === p ? "is-active" : ""}`}
            aria-pressed={period === p}
            onClick={() => onPeriod(p)}
            title={`${periodCount(p)} in this window`}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>
    </div>
  );
}
