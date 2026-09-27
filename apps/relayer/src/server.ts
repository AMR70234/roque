/**
 * The standalone Roque backend. A thin Fastify shell over the shared handlers in
 * @roque/core: every route here does three things and no more, namely read the
 * request, hand it to the matching handler, and translate an ApiError into a
 * status code. All the real behaviour lives in core so the web app's serverless
 * routes answer identically. Keep this file boring on purpose.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { serverEnv } from "@roque/core/env";
import {
  ApiError,
  handleAuthChallenge,
  handleAuthSession,
  handleInterpret,
  handleQuote,
  handlePrice,
  handleReserves,
  handlePrepareSwap,
  handleConfirmSwap,
  handleGrant,
  handleExecute,
  handleAgentInfo,
  handleCapability,
  handleVault,
  handleActivity,
  handleKeeperTick,
  handleIndex,
  handleHealth,
  handleCreateEventOrder,
  handleScreenEventOrder,
  handleEventOrders,
  handleCancelEventOrder,
  handleCreatePlaybook,
  handleArmPlaybook,
  handlePlaybooks,
  handlePlaybook,
  handleCancelPlaybook,
  handleReadShare,
  handleRecentShares,
  handleMyShares,
  handlePublishShare,
  handleForkShare,
  handleProposals,
  handleRefreshProposals,
  handleAcceptProposal,
  handleDismissProposal,
  handleJudgmentTick,
} from "@roque/core/api";
import { startWorkers } from "./workers.js";

const app = Fastify({
  logger: {
    level: "info",
    transport: { target: "pino-pretty", options: { colorize: true, translateTime: "HH:MM:ss" } },
  },
});

await app.register(cors, { origin: true });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof ApiError) {
    reply.status(err.status).send({ error: err.message });
    return;
  }
  app.log.error(err);
  reply.status(500).send({ error: "Something went wrong on our side. Try again in a moment." });
});

// ── Health and static info ────────────────────────────────────
app.get("/health", async () => handleHealth());
app.get("/agent", async () => handleAgentInfo());

// ── Wallet authentication ────────────────────────────────────
app.post("/auth/challenge", async (req) => handleAuthChallenge(req.body));
app.post("/auth/session", async (req) => handleAuthSession(req.body));

// ── Judgment and market ───────────────────────────────────────
app.post("/interpret", async (req) =>
  handleInterpret(req.body, bearerToken(req.headers.authorization)),
);
app.post("/quote", async (req) => handleQuote(req.body));
app.post("/reserves", async (req) => handleReserves(req.body));
app.get("/price", async () => handlePrice());

// ── Copilot: user-signed swaps ────────────────────────────────
app.post("/swap/prepare", async (req) => handlePrepareSwap(req.body));
app.post("/swap/confirm", async (req) => handleConfirmSwap(req.body));

// ── Autonomous: grants and the executor ───────────────────────
app.post("/grant", async (req) =>
  handleGrant(req.body, bearerToken(req.headers.authorization)),
);
app.post("/execute", async (req) =>
  handleExecute(req.body, bearerToken(req.headers.authorization)),
);

// ── Dashboard reads ───────────────────────────────────────────
app.get<{ Params: { user: string } }>("/capability/:user", async (req) =>
  handleCapability(req.params.user),
);
app.get<{ Params: { user: string } }>("/vault/:user", async (req) => handleVault(req.params.user));
app.get<{ Params: { user: string }; Querystring: { limit?: string } }>(
  "/activity/:user",
  async (req) => handleActivity(req.params.user, Number(req.query.limit ?? 25)),
);

// ── Event orders: limit orders on real-world conditions ───────
// Screening is the slow one. It asks GenLayer whether the condition is even
// checkable before the order is allowed to rest, so expect tens of seconds.
app.post("/events", async (req) =>
  handleCreateEventOrder(req.body, bearerToken(req.headers.authorization)),
);
app.post("/events/screen", async (req) =>
  handleScreenEventOrder(req.body, bearerToken(req.headers.authorization)),
);
app.post("/events/cancel", async (req) =>
  handleCancelEventOrder(req.body, bearerToken(req.headers.authorization)),
);
app.get<{ Params: { user: string } }>("/events/:user", async (req) =>
  handleEventOrders(req.params.user, bearerToken(req.headers.authorization)),
);

// ── Playbooks: a plan the keeper walks one step at a time ──────
app.post("/playbooks", async (req) =>
  handleCreatePlaybook(req.body, bearerToken(req.headers.authorization)),
);
app.post("/playbooks/arm", async (req) =>
  handleArmPlaybook(req.body, bearerToken(req.headers.authorization)),
);
app.post("/playbooks/cancel", async (req) =>
  handleCancelPlaybook(req.body, bearerToken(req.headers.authorization)),
);
app.get<{ Params: { id: string } }>("/playbooks/detail/:id", async (req) =>
  handlePlaybook(req.params.id, bearerToken(req.headers.authorization)),
);
app.get<{ Params: { user: string } }>("/playbooks/:user", async (req) =>
  handlePlaybooks(req.params.user, bearerToken(req.headers.authorization)),
);

// ── Shares: a thesis that travels without the position ────────
// Reading a share is deliberately public — that is the whole point of the link.
// Everything that touches a vault still needs the session.
app.post("/shares", async (req) =>
  handlePublishShare(req.body, bearerToken(req.headers.authorization)),
);
app.post("/shares/fork", async (req) =>
  handleForkShare(req.body, bearerToken(req.headers.authorization)),
);
app.get("/shares/recent", async () => handleRecentShares());
app.get<{ Params: { user: string } }>("/shares/mine/:user", async (req) =>
  handleMyShares(req.params.user, bearerToken(req.headers.authorization)),
);
// Registered after the two literal paths above so Fastify matches those first.
// Slugs always carry a random suffix, so one can never collide with them anyway.
app.get<{ Params: { slug: string } }>("/shares/:slug", async (req) =>
  handleReadShare(req.params.slug),
);

// ── Proposals: where the agent speaks first ───────────────────
app.get<{ Params: { user: string } }>("/proposals/:user", async (req) =>
  handleProposals(req.params.user, bearerToken(req.headers.authorization)),
);
app.post("/proposals/refresh", async (req) =>
  handleRefreshProposals(req.body, bearerToken(req.headers.authorization)),
);
app.post("/proposals/accept", async (req) =>
  handleAcceptProposal(req.body, bearerToken(req.headers.authorization)),
);
app.post("/proposals/dismiss", async (req) =>
  handleDismissProposal(req.body, bearerToken(req.headers.authorization)),
);

// ── Worker nudges, guarded by the shared cron secret ──────────
app.post<{ Headers: { "x-cron-secret"?: string } }>("/tick/keeper", async (req, reply) => {
  requireCron(req.headers["x-cron-secret"], reply);
  return handleKeeperTick();
});
app.post<{ Headers: { "x-cron-secret"?: string } }>("/tick/index", async (req, reply) => {
  requireCron(req.headers["x-cron-secret"], reply);
  return handleIndex();
});
app.post<{ Headers: { "x-cron-secret"?: string } }>("/tick/judgment", async (req, reply) => {
  requireCron(req.headers["x-cron-secret"], reply);
  return handleJudgmentTick();
});

function requireCron(provided: string | undefined, reply: import("fastify").FastifyReply) {
  if (provided !== serverEnv().cronSecret) {
    reply.status(401).send({ error: "Not authorised." });
    throw new Error("unauthorised cron");
  }
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header?.match(/^Bearer ([A-Za-z0-9_-]+)$/u);
  return match?.[1];
}

const env = serverEnv();

app
  .listen({ port: env.port, host: "0.0.0.0" })
  .then(() => {
    // With the HTTP surface up, start the in-process loops so a single
    // `pnpm relayer` gives you the whole live backend, not just the API.
    startWorkers(app.log);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
