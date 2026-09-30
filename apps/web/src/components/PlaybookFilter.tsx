"use client";

/**
 * The playbook list, narrowed, on the same two axes as the watch list and for
 * the same reason: once a few plans have run, finding the one still walking
 * means scrolling past the ones that finished.
 *
 * The buckets differ from the event ones because a playbook's states mean
 * different things. "Running" is the armed plans the keeper is walking. "Failed"
 * stands on its own rather than being folded in with the endings, because a plan
 * that broke mid-ladder is the one worth looking at — it may have traded some
 * rungs and not others, and that is a position somebody needs to know about.
 * Drafts are their own bucket too, since a draft is a plan that holds nothing
 * and is waiting on the person rather than on the market.
 */

import type { Playbook } from "@/lib/types";

export type PlaybookGroup = "all" | "running" | "failed" | "done" | "draft";
export type PlaybookPeriod = "all" | "24h" | "7d" | "30d";

/**
 * Annotated rather than inferred: with `satisfies`, each entry keeps its own
 * literal tuple type and the lookup below widens to a union of tuples whose
 * `includes` accepts nothing at all.
 */
export const PLAYBOOK_GROUPS: Record<PlaybookGroup, Playbook["status"][] | null> = {
  all: null,
  running: ["armed"],
  failed: ["failed"],
  done: ["completed", "cancelled"],
  draft: ["draft"],
};

export const PLAYBOOK_PERIODS: Record<PlaybookPeriod, number | null> = {
  all: null,
  "24h": 1,
  "7d": 7,
  "30d": 30,
};

const GROUP_LABELS: Record<PlaybookGroup, string> = {
  all: "All",
  running: "Running",
  failed: "Failed",
  done: "Finished",
  draft: "Drafts",
};

const PERIOD_LABELS: Record<PlaybookPeriod, string> = {
  all: "Any time",
  "24h": "24 hours",
  "7d": "7 days",
  "30d": "30 days",
};

const GROUP_ORDER: PlaybookGroup[] = ["all", "running", "failed", "done", "draft"];
const PERIOD_ORDER: PlaybookPeriod[] = ["all", "24h", "7d", "30d"];

export function inGroup(book: Playbook, group: PlaybookGroup): boolean {
  const statuses = PLAYBOOK_GROUPS[group];
  return statuses === null || statuses.includes(book.status);
}

/**
 * Counted from `createdAt`, and a row whose date will not parse is kept rather
 * than hidden — losing a plan to a bad timestamp is worse than showing it in
 * the wrong bucket.
 */
export function inPeriod(book: Playbook, period: PlaybookPeriod, now = Date.now()): boolean {
  const days = PLAYBOOK_PERIODS[period];
  if (days === null) return true;
  const made = new Date(book.createdAt).getTime();
  if (!Number.isFinite(made)) return true;
  return made >= now - days * 86_400_000;
}

export function filterPlaybooks(
  books: Playbook[],
  group: PlaybookGroup,
  period: PlaybookPeriod,
): Playbook[] {
  const now = Date.now();
  return books.filter((b) => inGroup(b, group) && inPeriod(b, period, now));
}

export function PlaybookFilter({
  books,
  group,
  period,
  onGroup,
  onPeriod,
}: {
  books: Playbook[];
  group: PlaybookGroup;
  period: PlaybookPeriod;
  onGroup: (group: PlaybookGroup) => void;
  onPeriod: (period: PlaybookPeriod) => void;
}) {
  if (books.length === 0) return null;

  const now = Date.now();
  // Each count is taken under the other filter, so the number on a status is
  // what picking it would really show within the period already chosen.
  const inWindow = books.filter((b) => inPeriod(b, period, now));
  const groupCount = (g: PlaybookGroup) => inWindow.filter((b) => inGroup(b, g)).length;
  const ofGroup = books.filter((b) => inGroup(b, group));
  const periodCount = (p: PlaybookPeriod) => ofGroup.filter((b) => inPeriod(b, p, now)).length;

  return (
    <div className="event-filter">
      <div className="event-filter-row" role="group" aria-label="Filter by status">
        {GROUP_ORDER.map((g) => (
          <button
            key={g}
            type="button"
            className={`feed-tab ${group === g ? "is-active" : ""}`}
            aria-pressed={group === g}
            onClick={() => onGroup(g)}
          >
            {GROUP_LABELS[g]}
            <span className="event-filter-count">{groupCount(g)}</span>
          </button>
        ))}
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
