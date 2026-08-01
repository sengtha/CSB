# Bridging a dollar IN: Fuji C-Chain → CSB

How to bring testnet USDC from Avalanche's Fuji C-Chain onto CSB, and what to build
once it arrives.

This is the **opposite direction** from `docs/fuji-ictt.md`. That document moves KHRt
out; this one brings a foreign asset in. Read that one first — the relayer, the ICM
registry and most of the traps are shared, and this document does not repeat them.

## Why bother

Every experiment on this chain so far has priced KHRt against either itself or a test
token nobody trades. That limits three things at once:

- **Aave has one reserve**, so "borrowing" means depositing riel to borrow riel, and
  liquidation can only be demonstrated by tightening the liquidation threshold rather
  than by moving a price.
- **The Uniswap pool's ratio is whatever it was seeded at**, so the TWAP averages a
  number we chose.
- **The administered-versus-market divergence** in `docs/oracle.md` is therefore two
  numbers we set, subtracted.

A riel–dollar rate is the first quantity here with a genuinely external answer. It is
the measurement the oracle work exists to make and currently cannot.

## What arrives is not gated — decided, not overlooked

ICTT delivers by deploying an `ERC20TokenRemote` on the destination chain and minting
to whatever recipient the sender names. That contract is a plain ERC-20: **no identity
check, no freeze, no confiscate.** Inside a chain whose whole claim is that every
holder is known, a bridged asset is a bearer instrument.

This was weighed and accepted on 2026-08-01 — the reasoning, what it gives up, and why
the alternatives were rejected are in `docs/architecture.md` §7.1 and `docs/todo.md`
item 3. The short version:

- an address absent from `txAllowList` can **receive** the token and do nothing else
  with it — no spend, no bridge-out, no delegation, because all three need a
  transaction it cannot submit;
- admission to that allow list is an act of the authority, and every transfer is
  permanently on chain, so **visibility survives even though control does not**;
- what is given up is control: no freeze, no confiscate, no forced transfer, no tier
  limit, no daily cap. A judicial order that works against KHRt has nothing to act on.

Two operating consequences follow. `scripts/audit-allowlist.js` becomes a **routine**
control rather than an occasional check, because the traceability argument rests on
allow-list admission being recorded against an identity — and nothing on chain
enforces that. And **mis-sent funds are unrecoverable**: `forcedTransfer` does not
exist on a token we did not write, so a typo is permanent.

## Before you start

**Verify the USDC address rather than trusting any document, including this one.**

```bash
node scripts/check-fuji-usdc.js
```

It defaults to `0x5425890298aed601595a70AB815c96711a31Bc65` — Circle's testnet USDC on
Fuji — and checks it: code present, `symbol`, `decimals`, non-zero supply, and whether
it proxies to an implementation that actually exists. Read-only, no key, no CSB
configuration. Override with `CSB_FUJI_USDC`.

Expect `USDC`, `6` decimals. Anything else, stop.

> **Checked 2026-08-01** against Fuji (chainId 43113) at block 57,491,619:
> `USD Coin` / `USDC` / 6 decimals, supply ≈ 90.09 billion. The large supply is
> ordinary for a faucet-minted testnet token and is not a signal of anything.
> Re-run the script rather than relying on this note — it is a record of one
> observation, not a guarantee about a contract that can change.

This is worth a script rather than a glance because **the Home wraps whatever address
it is given**, and it wraps a wrong one just as happily. The result is a market that
runs perfectly while being denominated in something that is not a dollar — an error
with no symptom, found much later by someone reconciling a number that never made
sense. Circle's testnet deployments also move over time.

The script proves the contract answers correctly. It cannot prove Circle issued it, so
cross-check in a public explorer as well —
`https://testnet.snowtrace.io/token/<address>`.

You also need, on the Fuji side: **Fuji AVAX** for gas, and **USDC** to actually
bridge (Circle runs a faucet). On the CSB side, the same three allow-list grants
`docs/fuji-ictt.md` §"Before you start" lists — they are per-address, not per-token,
so if the KHRt bridge already works these are already in place.

**The relayer does not need redeploying.** The one configured in `docs/fuji-ictt.md`
§3 carries `csb ↔ C-Chain` in both directions, which is exactly what this needs.
Confirm it is actually running before starting — a bridge with no relayer looks like a
bridge that hangs:

```bash
ps aux | grep -i icm-relayer | grep -v grep
ss -ltnp | grep 9095
```

## Step 1 — Deploy the ICTT pair, this time with the Home on Fuji

```bash
avalanche interchain tokenTransferrer deploy
```

- Network: **Fuji Testnet**
- Home blockchain: **C-Chain** — *this is the reversal.* For KHRt the home was `csb`.
- Home RPC: `https://api.avax-test.network/ext/bc/C/rpc`
- Token: **"Deploy a new Home for the token"** → **"An ERC-20 token"** → the **USDC
  address you verified above**
- Home key: any key with Fuji AVAX
- Remote: **csb**, with its RPC
- Remote key: a key with contract-deploy rights on CSB and tRIEL

**Write down both addresses.** The one you want for everything below is the **remote
on CSB**, not the home on Fuji. The CLI prints both and its ICM table shows Fuji's
addresses even while describing CSB (`docs/fuji-ictt.md` §1), so this is the single
easiest thing to get wrong in the whole procedure.

Expect the run to end with `Error: timeout waiting for remote endpoint registration`
if no relayer is running. That is not a failed deployment — both contracts exist, they
just do not know about each other yet. **Do not re-run the deploy**; it deploys a
second remote and orphans the first. Register the existing one instead
(`docs/fuji-ictt.md` §4).

## Step 2 — Verify and record it on CSB

```bash
source ops/csb-env.sh
CSB_BRIDGED_TOKEN=<remote on CSB> CSB_EXPECT_SYMBOL=USDC \
  npx hardhat run scripts/usdc-ingress.js --network csbRemote
```

This deploys nothing. It reads `symbol`, `decimals`, `tokenHomeBlockchainID`,
`tokenHomeAddress` and `isRegistered` off the contract, refuses if the symbol is not
what you expect, prints the compliance posture in plain words, and records the result
under `bridged.usdc` in `deployments.json`.

The check that earns its keep is `tokenHomeBlockchainID()`: an ordinary ERC-20 does
not answer it, so passing the wrong address is caught here rather than three steps
later.

## Step 3 — Send some dollars across

From Fuji, using the Home contract, exactly as `scripts/bridge-back.js` does in the
other direction. **Pre-check the recipient**: the delivery mints on CSB, so a
recipient that cannot transact will hold tokens it can never move.

Confirm arrival on CSB:

```bash
node -e '
const {ethers}=require("ethers");const d=require("./app/deployments.json");
(async()=>{const p=new ethers.JsonRpcProvider(process.env.CSB_RPC_URL);
const t=new ethers.Contract(d.bridged.usdc.address,
  ["function balanceOf(address) view returns (uint256)"],p);
console.log(await t.balanceOf("<recipient>"));})()'
```

## Step 4 — Build the market

```bash
source ops/csb-env.sh
CSB_USD_RATE=4000 CSB_SEED_USD=1000 \
  npx hardhat run scripts/usdc-market.js --network csbRemote
```

Four modules, each skippable with `CSB_SKIP=pool,twap,rate,aave`:

1. **pool** — creates KHRt/USDC on the existing Uniswap factory, marks it a KHRt
   system contract, and seeds it at `CSB_USD_RATE`. If the deployer is short of either
   token it records the pair and stops rather than half-seeding.
2. **twap** — a `UniswapV2TwapOracle` over that pool. Needs feeding afterwards; see
   `docs/oracle.md`.
3. **rate** — publishes the same figure as an administered rate, if the signer holds
   `RATE_PUBLISHER_ROLE`.
4. **aave** — lists USDC as a **second reserve** at LTV 75% / threshold 80% / bonus
   105%. It deploys fresh token implementations rather than reusing the first
   reserve's proxies — `initReserves` takes implementations and clones them per
   reserve, and passing an existing proxy lists a reserve backed by another reserve's
   storage, which deploys cleanly and then misbehaves. It also refuses to list an
   asset the live oracle cannot price, because every read on such a reserve reverts.

## What is evidence here, and what is not

**Not evidence: the rate.** Somebody has to put the first liquidity in, and whatever
ratio they choose *is* the market price until someone trades against it. Module 3
publishes the same number, so the administered-versus-market divergence starts at zero
**by construction**. It measures nothing yet.

**Evidence: everything the second asset unlocks.** With two reserves, borrowing means
posting one asset against another, liquidation can be demonstrated by moving a price
rather than by tightening a threshold, and the oracle machinery has something real to
disagree about. The instrumentation is genuine even while the numbers are assumed.

The measurement begins when a party with an independent view of the riel–dollar rate
arbitrages the pool. Until then, say "instrumented", not "measured".
