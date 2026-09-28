/**
 * Shares: a thesis as a link somebody else can fork.
 *
 * The thing people want to pass around is not a position, it is the reasoning:
 * "here is the condition I think matters and the trade I would put behind it."
 * A share carries exactly that, and forking it creates the recipient's own
 * order or playbook, in their own vault, at a size they choose.
 *
 * Two decisions here are worth stating plainly, because both are about not
 * leaking and not breaking.
 *
 * The payload is a frozen snapshot, deliberately not a pointer at the row it
 * came from. If it were a pointer, the author cancelling their own order would
 * break every link to it, and a reader would be able to watch a stranger's live
 * position. What travels is the idea; the author's address appears as a byline
 * and nothing else of theirs comes along.
 *
 * And a fork is never armed by the act of forking. An event order arrives in
 * screening and a playbook arrives as a draft, so the verifiability screen runs
 * for the person who forked it, under their own judgment. A shared link cannot
 * be a way to hand somebody a live rule that nothing vetted.
 */

import { randomBytes } from "node:crypto";
import { q } from "./db/index.js";
import { createEventOrder, getEventOrder, type EventOrder } from "./events.js";
import {
  createPlaybook,
  getPlaybook,
  normaliseStep,
  describeStep,
  type Playbook,
  type PlaybookStep,
} from "./playbooks.js";

export type ShareKind = "event_order" | "playbook";

export interface EventOrderPayload {
  condition: string;
  tokenIn: string;
  tokenOut: string;
  amount: string;
  amountIsPercent: boolean;
  slippageBps: number;
}

export interface PlaybookPayload {
  name: string;
  note: string | null;
  steps: PlaybookStep[];
  slippageBps: number;
}

export interface Share {
  slug: string;
  kind: ShareKind;
  author: string;
  title: string;
  note: string | null;
  payload: EventOrderPayload | PlaybookPayload;
  forks: number;
  views: number;
  createdAt: string;
  /** Plain-English lines describing what forking this would set up. */
  summary: string[];
}

interface ShareRow {
  slug: string;
  kind: ShareKind;
  author_address: string;
  title: string;
  note: string | null;
  payload: EventOrderPayload | PlaybookPayload;
  forks: number;
  views: number;
  created_at: string;
}

/**
 * A slug that reads like its subject and still cannot be guessed. The readable
 * half is for the person pasting it into a chat; the random half is the part
 * that stops anyone enumerating other people's shares.
 */
function makeSlug(title: string): string {
  const readable = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 28);
  const rand = randomBytes(5).toString("base64url").replace(/[^A-Za-z0-9]/gu, "").slice(0, 7);
  return readable ? `${readable}-${rand}` : rand;
}

function summarise(kind: ShareKind, payload: EventOrderPayload | PlaybookPayload): string[] {
  if (kind === "event_order") {
    const p = payload as EventOrderPayload;
    const size = p.amountIsPercent ? `${p.amount}% of your ${p.tokenIn}` : `${p.amount} ${p.tokenIn}`;
    return [`If ${p.condition}, swap ${size} for ${p.tokenOut}`];
  }
  const p = payload as PlaybookPayload;
  return p.steps.map((s, i) => `${i + 1}. ${s.label || describeStep(s.trigger, s.action)}`);
}

function toShare(row: ShareRow): Share {
  return {
    slug: row.slug,
    kind: row.kind,
    author: row.author_address,
    title: row.title,
    note: row.note,
    payload: row.payload,
    forks: row.forks,
    views: row.views,
    createdAt: row.created_at,
    summary: summarise(row.kind, row.payload),
  };
}

// ─────────────────────────────────────────────────────────────
// Publishing
// ─────────────────────────────────────────────────────────────

async function insert(
  kind: ShareKind,
  author: string,
  title: string,
  note: string | null,
  payload: EventOrderPayload | PlaybookPayload,
): Promise<Share> {
  const clean = title.trim();
  if (!clean) throw new Error("A share needs a title.");
  if (clean.length > 140) throw new Error("Keep the title under 140 characters.");

  // Two attempts is plenty against a 5-byte random suffix; the retry exists so a
  // collision is a retry rather than a 500 to somebody hitting publish.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const slug = makeSlug(clean);
    const rows = await q<ShareRow>(
      `INSERT INTO shares (slug, kind, author_address, title, note, payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (slug) DO NOTHING RETURNING *`,
      [slug, kind, author.toLowerCase(), clean, note?.trim() || null, JSON.stringify(payload)],
    );
    if (rows[0]) return toShare(rows[0]);
  }
  throw new Error("Could not mint a link for that title. Try again.");
}

/** Publish an existing event order of your own as a link. */
export async function shareEventOrder(
  id: string,
  user: string,
  meta: { title?: string; note?: string } = {},
): Promise<Share> {
  const order = await getEventOrder(id);
  if (!order || order.user.toLowerCase() !== user.toLowerCase()) {
    throw new Error("That order is not yours to share.");
  }
  if (order.status === "rejected") {
    throw new Error("That order was refused as unverifiable, so there is nothing worth sharing.");
  }
  const payload: EventOrderPayload = {
    condition: order.condition,
    tokenIn: order.tokenIn,
    tokenOut: order.tokenOut,
    amount: order.amount,
    amountIsPercent: order.amountIsPercent,
    slippageBps: order.slippageBps,
  };
  return insert("event_order", user, meta.title ?? order.condition, meta.note ?? null, payload);
}

/** Publish an existing playbook of your own as a link. */
export async function sharePlaybook(
  id: string,
  user: string,
  meta: { title?: string; note?: string } = {},
): Promise<Share> {
  const pb = await getPlaybook(id);
  if (!pb || pb.user.toLowerCase() !== user.toLowerCase()) {
    throw new Error("That playbook is not yours to share.");
  }
  // Strip the run state. A reader gets the plan, never the author's fills.
  const steps = pb.steps.map((s) => ({
    ...s,
    status: "waiting" as const,
    screen: null,
    txHash: null,
    error: null,
    armedAt: null,
    firedAt: null,
    checks: 0,
    lastCheckedAt: null,
    verdict: null,
  }));
  const payload: PlaybookPayload = {
    name: pb.name,
    note: pb.note,
    steps,
    slippageBps: pb.slippageBps,
  };
  return insert("playbook", user, meta.title ?? pb.name, meta.note ?? pb.note ?? null, payload);
}

// ─────────────────────────────────────────────────────────────
// Reading and forking
// ─────────────────────────────────────────────────────────────

/** Read a share. The view count is bumped in the same statement that reads it. */
export async function readShare(slug: string): Promise<Share | null> {
  const rows = await q<ShareRow>(
    `UPDATE shares SET views = views + 1 WHERE slug=$1 RETURNING *`,
    [slug],
  );
  return rows[0] ? toShare(rows[0]) : null;
}

/** Read without counting a view, for internal callers. */
export async function peekShare(slug: string): Promise<Share | null> {
  const rows = await q<ShareRow>(`SELECT * FROM shares WHERE slug=$1`, [slug]);
  return rows[0] ? toShare(rows[0]) : null;
}

export async function listShares(author: string, limit = 50): Promise<Share[]> {
  const rows = await q<ShareRow>(
    `SELECT * FROM shares WHERE LOWER(author_address)=LOWER($1)
      ORDER BY created_at DESC LIMIT $2`,
    [author, limit],
  );
  return rows.map(toShare);
}

export async function recentShares(limit = 20): Promise<Share[]> {
  const rows = await q<ShareRow>(
    `SELECT * FROM shares ORDER BY created_at DESC LIMIT $1`,
    [limit],
  );
  return rows.map(toShare);
}

export interface ForkOverrides {
  amount?: string;
  amountIsPercent?: boolean;
  slippageBps?: number;
  expiresInDays?: number;
}

export type ForkResult =
  | { kind: "event_order"; order: EventOrder }
  | { kind: "playbook"; playbook: Playbook };

/**
 * Copy a share into the caller's own account. Sizing is the forker's decision,
 * which is the point: the author's position size says nothing about what this
 * person should risk. Anything not overridden falls back to the snapshot.
 */
export async function forkShare(
  slug: string,
  user: string,
  overrides: ForkOverrides = {},
): Promise<ForkResult> {
  const share = await peekShare(slug);
  if (!share) throw new Error("No such link.");

  if (share.kind === "event_order") {
    const p = share.payload as EventOrderPayload;
    const order = await createEventOrder({
      user,
      condition: p.condition,
      tokenIn: p.tokenIn,
      tokenOut: p.tokenOut,
      amount: overrides.amount ?? p.amount,
      amountIsPercent: overrides.amountIsPercent ?? p.amountIsPercent,
      slippageBps: overrides.slippageBps ?? p.slippageBps,
      expiresInDays: overrides.expiresInDays,
      sourceSlug: slug,
    });
    await q(`UPDATE shares SET forks = forks + 1 WHERE slug=$1`, [slug]);
    return { kind: "event_order", order };
  }

  const p = share.payload as PlaybookPayload;
  // Re-normalise rather than trusting the stored shape. A share row is data a
  // stranger's browser produced, and it may predate a change to what a step may
  // contain, so it is validated again on the way in.
  const steps = p.steps.map((s, i) =>
    normaliseStep(
      {
        label: s.label,
        trigger: s.trigger,
        action: {
          ...s.action,
          // A single amount override scales the first step only; the later steps
          // keep their own relative sizing, which is usually what the plan meant.
          amount: i === 0 ? (overrides.amount ?? s.action.amount) : s.action.amount,
          amountIsPercent:
            i === 0 ? (overrides.amountIsPercent ?? s.action.amountIsPercent) : s.action.amountIsPercent,
        },
      },
      i,
    ),
  );
  const playbook = await createPlaybook({
    user,
    name: p.name,
    note: p.note ?? undefined,
    steps,
    slippageBps: overrides.slippageBps ?? p.slippageBps,
    sourceSlug: slug,
  });
  await q(`UPDATE shares SET forks = forks + 1 WHERE slug=$1`, [slug]);
  return { kind: "playbook", playbook };
}
