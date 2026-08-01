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
>
> **Provenance confirmed independently**: tokens received at this address from
> Circle's own faucet the same day. That is the part the script cannot establish —
> it proves a contract answers correctly, not who deployed it — so a faucet
> transfer, or a Snowtrace listing, is what actually closes the question.
>
> Re-run the script rather than relying on this note. It records one observation,
> not a guarantee about a contract that can change.

This is worth a script rather than a glance because **the Home wraps whatever address
it is given**, and it wraps a wrong one just as happily. The result is a market that
runs perfectly while being denominated in something that is not a dollar — an error
with no symptom, found much later by someone reconciling a number that never made
sense. Circle's testnet deployments also move over time.

The script proves the contract answers correctly. It cannot prove Circle issued it, so
cross-check in a public explorer as well —
`https://testnet.snowtrace.io/token/<address>`.

You also need, on the Fuji side: **Fuji AVAX** for gas, and **USDC** to actually
bridge (Circle runs a faucet at `faucet.circle.com` — pick Avalanche Fuji). Check both
at once by passing your address to the same script:

```bash
CSB_FUJI_ADDR=0xYourFujiAddress node scripts/check-fuji-usdc.js
```

It flags an empty balance on either side rather than leaving you to read two numbers
and remember which matters.

**Size the plan to the faucet, not to the defaults.** Circle's faucet hands out small
amounts, so a realistic balance is tens of dollars rather than thousands, and
`scripts/usdc-market.js` defaults to seeding the pool with **1,000 USDC**. With less
than that it records the pair and stops without seeding — safe, but a wasted run. A
workable split for ~40 USDC:

| Purpose | Amount | Why |
|---|---|---|
| Bridge to CSB | 35 | leave a few on Fuji to test the return path later |
| Seed the pool | 20 | with 80,000 KHRt at 4,000 riel — sets the initial price |
| Aave collateral | 10 | enough to post and borrow against |
| Spare | 5 | second bridge transfer, fee headroom |

So `CSB_SEED_USD=20`, not the default. The pool is thin, which is fine for what it is:
`docs/oracle.md` already says a pool this size is a measurement instrument and not a
valuation source, and nothing points the lending market at its TWAP.

**On the CSB side** you need the same three allow-list grants `docs/fuji-ictt.md`
§"Before you start" lists. They are per-address, not per-token, so if the KHRt bridge
already works these are already in place.

**The relayer does not need redeploying** — the one from `docs/fuji-ictt.md` §3
carries `csb ↔ C-Chain` in both directions, which is what this needs. But confirm two
things, because a bridge whose relayer is not carrying its messages looks exactly like
a bridge that hangs.

Is it running:

```bash
ps aux | grep -i icm-relayer | grep -v grep
```

And will it carry a *new* pair:

```bash
node scripts/check-relayer.js
```

The config supports `allowed-origin-sender-addresses` and
`allowed-destination-addresses`, and **when either is populated it is the only address
relayed**. A new TokenHome/TokenRemote then emits messages nobody delivers: the send
succeeds, gas is spent, the event fires, the tokens never arrive — and everyone
inspects the bridge contracts, because the relayer is visibly running. The script
prints the routing table, flags both restrictions, and warns if a chain is configured
in one direction only (registration and transfers travel opposite ways, so a one-way
config stalls one of them). It never prints the per-destination signing keys the
config holds.

## Step 1 — Deploy the ICTT pair, this time with the Home on Fuji

```bash
avalanche interchain tokenTransferrer deploy
```

- Network: **Fuji Testnet**
- Home blockchain: **C-Chain** — *this is the reversal.* For KHRt the home was `csb`.
- Home RPC: `https://api.avax-test.network/ext/bc/C/rpc`
- Token: **"Deploy a new Home for the token"** → **"An ERC-20 token"** → the **USDC
  address you verified above**
- Home key: see the table below
- Remote: **csb**, with its RPC
- Remote key: see the table below

**Expect to be offered an existing Home, and decline it.** USDC is widely bridged, so
the CLI will very likely report that a Home for this token already exists on Fuji —
an address that is *not* the USDC address — and ask whether to use it. Answer **"No,
deploy my own Home."** Reusing a stranger's Home puts your collateral in a contract on
a chain you do not control, with no say over its lifecycle. The saved gas is not worth
it.

### Which key at which prompt

The wizard asks for two keys and offers every key in the store at each one. Most of
the answers are wrong, and one of them is wrong in a way that breaks something else
that is currently working.

| Prompt | Use | Why |
|---|---|---|
| Home deployment fees (Fuji) | a **fresh key**, e.g. `fuji-home`, funded with ~0.5 AVAX | needs Fuji AVAX and nothing else |
| Remote deployment (CSB) | `csb-deployer` | the only key with contract-deploy rights and tRIEL |

Do **not** pick:

- **`cli-awm-relayer`** — the relayer is running and holds its own nonce. Using its
  key concurrently collides with it (`docs/fuji-ictt.md` §4). This breaks message
  delivery for the bridge that already works.
- **`cli-teleporter-deployer`** — its private key was exposed in terminal output.
  Treat it as public.
- **`ewoq`** — avalanche-cli's built-in test key, published in Avalanche's own
  documentation. Anyone can spend what it holds.

**Do not import a personal wallet key to get past this prompt.** `avalanche key
import` writes the private key to `~/.avalanche-cli/key/` in plain text, and
`avalanche blockchain describe` prints keys from that directory. Create a throwaway
instead:

```bash
avalanche key create fuji-home
avalanche key list --fuji          # note the address, send it ~0.5 AVAX
```

**The USDC does not need to be on that key.** Collateral for a new ERC-20 Home
accrues as tokens are sent rather than up front, so the deploy key pays gas only. The
USDC stays wherever it is and is spent later by whatever address calls `send()`.

### Keep the right address

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

```bash
source ops/csb-env.sh
node scripts/bridge-in.js 25                      # to the council address
node scripts/bridge-in.js 25 0xRecipientOnCSB     # or somewhere specific
```

`CSB_DRY_RUN=1` runs every check and sends nothing.

**The check this script exists for.** There is no compliance gate on this path to
refuse a bad delivery, and no `forcedTransfer` to undo one, because the arriving
token is a contract we did not write — so a mis-sent transfer is permanent in a way
the same mistake with KHRt is not. The script refuses outright if the recipient is
not on CSB's `txAllowList`, because such an address can **receive** the token and then
do nothing with it at all: no spend, no bridge-out, no delegation, since each needs a
transaction it cannot submit. It also refuses if the remote is not yet registered, and
checks the destination before the sender's balance — being short is recoverable, and
the destination being wrong is not.

**A successful transaction here is not proof of arrival.** `send()` locks the tokens
in the Home on Fuji and emits an ICM message; they appear on CSB only when the relayer
delivers it. The script prints the balance check to run a minute later, and says to
look at `avalanche interchain relayer logs` if the balance stays zero.

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

## Recorded values from this deployment

The CLI could not deploy either half — see the note below — so both were deployed
directly. Addresses from 2026-08-01, chain 43113 / 8555:

| What | Address |
|---|---|
| Fuji USDC (Circle) | `0x5425890298aed601595a70AB815c96711a31Bc65` |
| `ERC20TokenHome` (Fuji C-Chain) | `0xdd3de04fEf14e07283aB0139D52defE76f5ea674` |
| `ERC20TokenRemote` (CSB) | `0xcF8C6A5659D2765f910217b1E4dd3348cFa9a601` |
| ICM registry (Fuji C-Chain) | `0xF86Cb19Ad8405AEFa7d09C778215D2Cb6eBfB228` |
| ICM registry (CSB) | `0x22C75bE6Cbe94050c16D5944a08144a81a54ED35` |
| Home deploy key `fuji-home` | `0x541a73bdf723A49d1281e333bc0f8e51832f50cc` |

### The CLI cannot deploy the Home, and says the wrong thing about why

`avalanche interchain tokenTransferrer deploy` (v1.9.6, the current release) fails
with:

```
Error: failure deploying ERC20 Home: exceeds block gas limit
```

on a C-Chain whose block gas limit is **32,000,000**. The deployment needs
**3,774,976** — measured, once the transaction was built by hand. So the ceiling was
never the problem. That string is go-ethereum's txpool rejecting `tx.Gas() >
blockGasLimit`, which means the CLI submitted a gas value larger than 32M for a 3.8M
deployment. Upgrading does not help; 1.9.6 is the latest.

The CSB half would very likely have failed the same way: 8555's block gas limit is
**8,000,000**, not the 20,000,000 `docs/chain-config.md` documents, and the remote
deployment needed 3,926,949. That discrepancy was found during this deployment and is
recorded there.

Use `scripts/deploy-token-home.js` instead. It builds the same transaction from the
artifacts the CLI itself downloaded and compiled — identical bytecode — but estimates
gas properly and, when estimation fails, reports the revert reason rather than
substituting a maximum. `scripts/deploy-token-remote.js` does the CSB half.

Both read the constructor's parameters **from the artifact ABI** rather than from a
signature read elsewhere, because avalanche-cli pins its own `icm-contracts` checkout
and that constructor has changed shape across versions. The pinned one here takes
four arguments with trailing underscores and no `minTeleporterVersion`:

```
(address teleporterRegistryAddress, address teleporterManager,
 address tokenAddress_, uint8 tokenDecimals_)
```

Filling by name means a different version either works or refuses with the full
signature — never silently maps values onto the wrong positions, which would deploy
something that looks fine and is wired wrong.

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
