/**
 * The public face of @roque/core. Both the standalone relayer and the web app's
 * server routes import from here, so this barrel is the one list of everything
 * the backend knows how to do. Grouped by concern, not alphabetised, so the
 * shape of the system reads top to bottom: config, chain, judgment, market,
 * intents, the product rules, and the two background workers.
 */

// Environment and the chain clients everything else is built on.
export { publicEnv, serverEnv, type ServerEnv } from "./env.js";
export { publicClient, relayerWallet, relayerAddress } from "./chain.js";

// The judgment layer.
export {
  interpret,
  readInterpretation,
  adjudicate,
  type Interpretation,
  type Adjudication,
} from "./genlayer.js";

// Reading the live market and the prices the contracts trust.
export {
  quoteSwap,
  poolReserves,
  minOutForSlippage,
  type Quote,
  type PoolReserves,
} from "./quote.js";
export {
  ethUsd,
  feedUsd,
  tokenUsd,
  allTokenUsd,
  usdValue,
  usdValueRaw,
  toTriggerPrice,
  type EthPrice,
  type FeedPrice,
} from "./prices.js";

// Signing and submitting agent intents, and reading a user's autonomous state.
export {
  signSwapIntent,
  signLimitIntent,
  submitSwap,
  submitLimitOrder,
  submitGrant,
  freshNonce,
  agentSignerAddress,
  getCapability,
  vaultBalance,
  remainingDailyUsd,
  grantNonce,
  type SwapIntent,
  type LimitIntent,
  type Capability,
} from "./intents.js";

// The product rules that sit above chain and database.
export {
  interpretCommand,
  prepareCopilotSwap,
  executeAutonomous,
  setStatus,
  attachTxHash,
  intentHistory,
  tradeHistory,
  type Mode,
  type InterpretResult,
} from "./services.js";

// The two background workers and the database they lean on.
export { indexOnce, indexToHead, DEPLOY_BLOCK } from "./indexer.js";
export { keeperTick, type KeeperResult } from "./keeper.js";
export { q, sql, ensureSchema, SCHEMA_SQL } from "./db/index.js";
export {
  issueWalletChallenge,
  completeWalletChallenge,
  authenticatedOwner,
  type WalletChallenge,
  type OwnerSession,
} from "./auth.js";

// The four judgment-driven products that sit on top of the rules above.
export {
  createEventOrder,
  screenEventOrder,
  evaluateEventOrder,
  listEventOrders,
  getEventOrder,
  cancelEventOrder,
  eventTick,
  gatherEvidence,
  type EventOrder,
  type EventOrderStatus,
  type Evidence,
  type EvidenceItem,
} from "./events.js";
export {
  createPlaybook,
  armPlaybook,
  advancePlaybook,
  listPlaybooks,
  getPlaybook,
  playbookLog,
  cancelPlaybook,
  playbookTick,
  describeStep,
  type Playbook,
  type PlaybookStep,
  type PlaybookTrigger,
  type PlaybookAction,
  type StepStatus,
} from "./playbooks.js";
export {
  shareEventOrder,
  sharePlaybook,
  readShare,
  peekShare,
  listShares,
  recentShares,
  forkShare,
  type Share,
  type ShareKind,
  type ForkResult,
} from "./shares.js";
// Which vault money is already promised, and so cannot be promised twice or
// withdrawn out from under the order that is waiting to spend it.
export {
  reserve,
  release,
  heldByToken,
  availability,
  assertWithdrawable,
  type ReservationSource,
  type ReservationInput,
  type TokenHold,
  type TokenAvailability,
} from "./reservations.js";
export {
  vaultFundingNeeds,
  assertVaultFunds,
  type FundingLeg,
  type FundingNeed,
} from "./funding.js";
export {
  generateProposals,
  listProposals,
  acceptProposal,
  dismissProposal,
  proposalTick,
  type Proposal,
  type ProposalAction,
} from "./proposals.js";

// The transport-agnostic request handlers both backends share.
export * as api from "./api.js";
export { ApiError } from "./api.js";
