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

The database stores interpretation and execution activity, not custody. Stored
autonomous intents are owner-checked and atomically claimed before signing to
prevent duplicate execution requests.

## API and Workers

The Next.js API routes and Fastify server are thin transport layers over the
same core handlers. They cover interpretation, quote/price/reserve reads,
wallet authentication, capability grants, vault reads, swap preparation and
confirmation, autonomous execution, activity, orders, and cron-protected
keeper/indexer jobs.

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
- The GenVM semantic validator currently depends on the SDK version resolved by
  its dependency header and linter toolchain.
