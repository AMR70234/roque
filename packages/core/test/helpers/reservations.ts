/**
 * An in-memory stand-in for the `vault_reservations` table.
 *
 * The reservations module is deliberately *not* mocked in the suites that reach
 * it. It is the thing deciding whether one deposit can back two orders, so a
 * test that stubs it out proves nothing about the property it exists to hold.
 * Instead the real module runs against this, which answers the four statements
 * it issues out of an array.
 *
 * Each suite's `q` mock delegates here first and falls through to its own
 * statements, so `handle` returns `null` — not `[]` — when a statement is none
 * of its business. An empty array is a legitimate answer to a `SELECT`, so the
 * two cases cannot share a value.
 */

export interface ReservationRow {
  user_address: string;
  token: string;
  amount_raw: string;
  percent: number | null;
  source_kind: string;
  source_id: string;
  step_index: number;
  status: "held" | "spent" | "released";
}

export interface ReservationStore {
  rows: ReservationRow[];
  /** Every open claim, for assertions. */
  held: () => ReservationRow[];
  /** Pre-load a claim, for testing what a *second* order is allowed to do. */
  hold: (row: Partial<ReservationRow> & { user_address: string; token: string }) => void;
  handle: (sql: string, params: unknown[]) => unknown[] | null;
}

export function reservationStore(): ReservationStore {
  const rows: ReservationRow[] = [];

  const store: ReservationStore = {
    rows,
    held: () => rows.filter((r) => r.status === "held"),

    hold: (row) =>
      rows.push({
        amount_raw: "0",
        percent: null,
        source_kind: "event_order",
        source_id: `seed-${rows.length}`,
        step_index: 0,
        status: "held",
        ...row,
      }),

    handle: (sql, params) => {
      const t = sql.replace(/\s+/gu, " ").trim();

      if (t.startsWith("INSERT INTO vault_reservations")) {
        const [, user, token, amountRaw, percent, kind, sourceId, stepIndex] = params as [
          string, string, string, string, number | null, string, string, number,
        ];
        // The real statement is an upsert on (source_kind, source_id,
        // step_index), and that idempotence is load-bearing: arming a playbook
        // twice must not claim the same money twice.
        const existing = rows.find(
          (r) =>
            r.source_kind === kind && r.source_id === sourceId && r.step_index === stepIndex,
        );
        if (existing) {
          existing.token = token;
          existing.amount_raw = amountRaw;
          existing.percent = percent;
          existing.status = "held";
          return [];
        }
        rows.push({
          user_address: user,
          token,
          amount_raw: amountRaw,
          percent,
          source_kind: kind,
          source_id: sourceId,
          step_index: stepIndex,
          status: "held",
        });
        return [];
      }

      // Releasing one rung of a ladder. Matched before the whole-source form,
      // because the two statements share their opening clause.
      if (t.startsWith("UPDATE vault_reservations") && t.includes("step_index=$3")) {
        const [kind, sourceId, stepIndex, outcome] = params as [string, string, number, string];
        for (const r of rows) {
          if (
            r.source_kind === kind &&
            r.source_id === sourceId &&
            r.step_index === stepIndex &&
            r.status === "held"
          ) {
            r.status = outcome as ReservationRow["status"];
          }
        }
        return [];
      }

      if (t.startsWith("UPDATE vault_reservations")) {
        const [kind, sourceId, outcome] = params as [string, string, string];
        for (const r of rows) {
          if (r.source_kind === kind && r.source_id === sourceId && r.status === "held") {
            r.status = outcome as ReservationRow["status"];
          }
        }
        return [];
      }

      if (t.startsWith("SELECT token, amount_raw, percent FROM vault_reservations")) {
        const user = String(params[0]).toLowerCase();
        return rows
          .filter((r) => r.status === "held" && r.user_address.toLowerCase() === user)
          .map((r) => ({
            token: r.token,
            amount_raw: r.amount_raw,
            percent: r.percent === null ? null : String(r.percent),
          }));
      }

      return null;
    },
  };

  return store;
}
