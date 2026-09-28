# Roque Architecture

Roque is an agent-native exchange running against Ethereum Sepolia. Natural
language is used to describe a trade, but language-model output never has
authority over funds. GenLayer interprets the request; deterministic Solidity
contracts validate and execute it.

## System Invariant

```text
AI can propose, reason, request, and coordinate.
AI cannot bypass deterministic authorization.
```

## Repository Structure

```text
contracts/             Solidity financial contracts, deployment script, tests
packages/shared/       ABIs, deployment registry, token/pool metadata, EIP-712 types
packages/core/         Shared backend/domain logic used by Next and the relayer
packages/genlayer/     Python GenLayer intelligent contract and tests
apps/web/              Next.js UI and serverless API routes
apps/relayer/          Fastify API wrapper plus keeper/indexer workers
```

The web serverless routes and the standalone relayer both call
`@roque/core`. This keeps authentication, intent handling, quoting, execution,
indexing, and database behavior consistent across deployments.

## On-Chain Layer

### Tokens and Pools

The Sepolia deployment contains ten faucet-backed ERC-20 test tokens:

```text
rUSDC  rUSDT  rDAI  rWETH  rWBTC
rLINK  rSNX   rFORTH rEURC rPAXG
```

`Deploy.s.sol` deploys one `LiquidityPool` for every unordered token pair,
giving 45 direct pools. Pools use constant-product pricing with a 30 bps fee,
LP shares, and deterministic reserve accounting. Pools are seeded at the
Chainlink-derived token prices recorded during deployment.

`DEXRouter` is intentionally thin. It registers pools, quotes a pair, and
executes exact-input swaps with a deadline and `minAmountOut` slippage floor.
It does not route through multi-hop paths because every supported pair has a
direct pool.

### OrderBook

`OrderBook` escrows input tokens and stores owner, pair, amount, output floor,
trigger price, direction, expiry, and status. Anyone may call
`executeOrder`, but the contract reads the deployed Chainlink ETH/USD feed and
rechecks the trigger and freshness before filling through the router. The
keeper only supplies liveness; it cannot force an untriggered fill.

Orders created directly by a user are owned and cancelled by that user.
Agent-created orders are also owned by the user, while `AgentExecutor` is
authorized only to create them.

### AgentExecutor

Autonomous funds are isolated in per-user token vaults. A capability grant
records the agent signer, per-trade USD cap, UTC-day USD cap, slippage cap,
expiry, and revocation state.

The user may submit the grant directly or sign an EIP-712 grant that the
relayer submits. Each autonomous swap or limit order then requires a separate
EIP-712 signature from the configured agent signer.

Before moving tokens, `AgentExecutor` checks:

- nonzero amount and unexpired intent;
- both tokens registered;
- existing, live, non-revoked capability;
- recovered signer matches the capability;
- nonce has not been used;
- Chainlink-valued input is within the per-trade and UTC-day caps;
- vault has enough input;
- swaps satisfy the capability's slippage floor.

The executor exposes typed operations only: vault deposit/withdraw,
`executeSwap`, and `createLimitOrder`. There is no arbitrary target/calldata
execution entrypoint.

### FaucetRouter

`TestToken` exposes a bounded faucet and owner-only minting. `FaucetRouter`
calls every token faucet with isolated failure handling, allowing a wallet to
claim the available portion of the ten-token set in one transaction.

## GenLayer Interpretation

`packages/genlayer/contracts/roque_interpreter.py` is the judgment layer. Its
public interpretation method sends the user's text through
`prompt_comparative`, then deterministically normalizes the response:

- token aliases map to the ten canonical symbols;
- swaps and limit orders are distinguished;
- amounts, percentages, trigger direction, and expiry are normalized;
- unknown/self trades, invalid amounts, percentages above 100, exact-output
  requests, and unsupported limit conditions are rejected.

The interpreter holds no Sepolia funds and cannot directly submit a Sepolia
transaction. Its result is advisory until the backend and contracts validate
it again. GenLayer deployment metadata is in
`packages/genlayer/deployment.json`.

The same contract's `adjudicate(request_id, condition, evidence_json)` method
serves two distinct stages for event orders, and both return
`{ met, confidence, rationale }`:

1. **Verifiability screening**, asked at arm time about the question itself:
   could any public source settle this condition? A `met: false` here means the
   condition is unanswerable, and the order is rejected with the rationale
   recorded.
2. **The verdict**, asked repeatedly against freshly gathered evidence while the
   order rests: has the event now happened?

A single method covers both because the second stage is only reachable for
conditions the first stage already accepted. No IC redeploy was required to add
event orders, playbooks, or proposals; they compose the deployed interpreter and
the deployed Sepolia contracts.

## Backend and Persistence

`packages/core` contains the application services:

- `env.ts` validates runtime configuration and keys;
- `chain.ts` owns public reads and relayer wallet access;
- `quote.ts` and `prices.ts` read AMM/Chainlink data;
- `genlayer.ts` submits interpretation requests and reads results;
- `services.ts` coordinates intent lifecycle, preparation, and autonomous
  execution;
- `auth.ts` implements wallet challenge/session authentication for autonomous
  requests;
- `db/` owns Neon Postgres access and schema migration;
- `indexer.ts` scans contract events from the deployment block, deduplicates by
  transaction hash and log index, and stores a block bookmark;
- `keeper.ts` scans open orders and attempts triggered fills.
- `events.ts` owns event orders: a cheap local screen, GenLayer verifiability
  screening, evidence gathering from public news and price feeds, adjudication,
  and execution of a met condition;
- `playbooks.ts` owns multi-step plans, the readiness and rationing rules for
  each trigger kind, and the single-step advance;
- `shares.ts` publishes an order or playbook to a public slug and forks one back
  into a caller's own account;
- `proposals.ts` derives agent proposals from a portfolio snapshot and turns an
  accepted proposal into a real order or playbook;
- `funding.ts` decides what the vault must already hold for a set of legs to be
  payable, and refuses a commitment it cannot cover. The arithmetic is pure and
  the chain read is a thin wrapper over it.

The database stores interpretation and execution activity, not custody. Stored
autonomous intents are owner-checked and atomically claimed before signing to
prevent duplicate execution requests.

The judgment features add five append-only tables: `event_orders`, `playbooks`,
`playbook_events`, `shares`, and `proposals`. They hold intent and reasoning,
never balances. Concurrency is handled the same way as intents: a playbook step
is claimed with a conditional update (`WHERE step_cursor=$3 AND status='armed'
AND (steps->$3->>'status') = 'waiting' RETURNING id`) and a worker that loses
that race returns without trading, so two overlapping ticks cannot fire the same
step twice.

## API and Workers

The Next.js API routes and Fastify server are thin transport layers over the
same core handlers. They cover interpretation, quote/price/reserve reads,
wallet authentication, capability grants, vault reads, swap preparation and
confirmation, autonomous execution, activity, orders, event orders, playbooks,
shares, the proposals inbox, and cron-protected keeper/indexer/judgment jobs.

Judgment work runs on its own loop, separate from the keeper. The relayer's
`serial()` helper wraps each worker so a pass that outlives its interval cannot
be overlapped by a second copy reading the same due rows, and the judgment and
proposals loops deliberately skip the boot kick so a restart does not open with
a minutes-long GenLayer pass before the API is warm. GenLayer round trips are
measured in tens of seconds, so screening is always its own phase and never
inline in a request: `EVENT_TICK_BUDGET` and `PLAYBOOK_TICK_BUDGET` cap how many
rows one pass will adjudicate, each row carries `last_checked_at` against a
per-trigger interval (30s for price, 10 minutes for event), and
`/api/cron/judgment` declares `maxDuration = 60` as the ceiling those budgets
are sized for.

The relayer's agent signer pays gas for autonomous transactions. It is
untrusted: the on-chain capability and executor checks remain authoritative.
The keeper has no special authority beyond paying gas to call the public order
fill method. Optional Latch RPC settings can place an additional off-chain
boundary around relayer/keeper RPC access; they do not replace on-chain caps.

## Frontend Flows

### Copilot

1. The user connects an external wallet through Privy.
2. The chat request is interpreted and stored.
3. The backend prepares a quote and slippage floor.
4. The browser approves the exact token amount if needed.
5. The connected wallet signs and submits the swap or limit order directly.
6. The UI records the transaction hash immediately and the indexer later
   reconciles the on-chain event.

Copilot swaps explicitly estimate gas through the app's public Sepolia RPC and
submit that estimate with a 20% margin. This avoids injected-wallet fallback
limits that exceed Infura's Sepolia transaction cap.

### Autonomous

1. The user signs and submits a bounded capability grant.
2. The user deposits tokens into the AgentExecutor vault.
3. The chat request is interpreted and stored.
4. The authenticated backend resolves percentages against vault balances,
   checks capability state, quotes the trade, and creates an agent-signed
   EIP-712 intent.
5. The relayer submits the typed intent to AgentExecutor.
6. The contract revalidates every bound and moves only vault funds.
7. For a limit order, the keeper attempts fills and the OrderBook rechecks the
   Chainlink trigger.

Autonomous confirmation mode waits for the user to trigger the backend
execution call. Direct mode starts that call immediately after interpretation.
Both modes use the same on-chain authorization.

### Event Orders, Playbooks, Links, and Proposals

1. The user states a condition or a chain of steps. An event order is created
   `screening`; a playbook is created `draft` and armed explicitly.
2. Unattended trades spend from `AgentExecutor.vaultBalance[user][token]` and
   nowhere else, so the vault is costed at the moment of commitment rather than
   at fill time: in `createEventOrder`, which leads straight into screening and
   arming, and in `armPlaybook`, which is where a draft becomes a commitment.
   `createPlaybook` is deliberately left open so a plan can be drafted, shared
   and forked before it is funded. Legs are summed per token across the whole
   plan; a leg whose input an earlier leg produces is skipped, so a ladder is
   not charged for money it creates. A percentage leg cannot be sized ahead of
   its fire time, so it only asserts a non-zero balance. Funding is checked
   before verifiability, because a consensus round is the expensive refusal and
   this is the cheap one. The read fails closed: an unreadable balance is not
   consent.
3. A local pattern screen refuses the obviously unanswerable (feelings, private
   matters, predictions) without spending a validator round trip.
4. The judgment worker screens surviving conditions through GenLayer. The order
   becomes `armed` with its sources recorded, or `rejected` with a reason. A
   screening call that fails leaves the row in `screening` to be retried, since a
   failure to ask is not a verdict.
5. While armed, the worker gathers evidence and adjudicates on the check
   interval. A `met` verdict at high or medium confidence executes through the
   same `AgentExecutor` path as any autonomous trade, so the user's signed caps,
   slippage gate, and expiry apply unchanged. Low confidence is recorded and
   does not fill.
6. Playbooks advance one step per pass, in order, and a step's own trigger
   (immediate, price, delay, or event) decides readiness. A failed fill fails
   the playbook rather than skipping ahead.
7. Publishing writes a `shares` row; forking re-validates every stored step
   against the current token registry, records `source_slug`, and sizes the
   position against the forker's own vault.
8. The proposals worker snapshots each active vault and derives proposals
   (`capability-expiring`, `rejected-condition`, `far-trigger`,
   `drawdown-ladder`, `rally-trim`, `idle-vault`). Bucketed dedupe keys keep a
   drifting price from refiling the same idea. Accepting one creates an ordinary
   event order or playbook; a proposal itself has no authority to move funds.

## Deployment and Source of Truth

`contracts/script/Deploy.s.sol` deploys the Sepolia stack and writes
`contracts/deployments/sepolia.json`. The equivalent checked-in file
`packages/shared/src/deployment.json` is the runtime address book consumed by
TypeScript. Contract ABIs in `packages/shared/src/abis` are checked-in
artifacts and must be refreshed when public contract interfaces change.

The current deployment is chain `11155111`. The README and shared deployment
JSON contain the user-facing addresses and token/pool registry.

## Known Limitations

- This is a testnet deployment using shallow demonstration liquidity.
- AMM spot prices are manipulable; Chainlink is used for autonomous caps and
  limit triggers.
- The relayer and keeper are centralized off-chain services, bounded by
  on-chain authorization.
- GenLayer-to-Sepolia writes are relayed off-chain; there is no trustless bridge.
- Event-order verdicts are only as good as the evidence a validator can reach.
  Evidence gathering is public news and price feeds over nondeterministic web
  access, so a true event that no reachable source reports reads as not met.
- Verifiability screening rejects an unanswerable condition, but it cannot prove
  a condition answerable in advance of the event itself.
- The GenVM semantic validator currently depends on the SDK version resolved by
  its dependency header and linter toolchain.
