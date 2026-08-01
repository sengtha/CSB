# Open items

Things found but deliberately not done, with enough context to act on later without
rediscovering why. Written 2026-07-30, while the chain is being tested rather than
changed.

Each item says what the decision actually is, because most of these are choices
rather than tasks — several trade one real property away for another.

---

## Compliance and design

### 1. A redeploy forks the compliance perimeter

**The problem.** Gated tokens bind their registry immutably:

```solidity
IdentityRegistry public immutable identity;   // KHRStablecoin.sol:28, LandTitleToken.sol:42
```

So redeploying the suite does not replace the perimeter, it **partitions** it. Proven
live on 8555: an earlier deployment is still running with its own registry
(`0x446BE7b37954b0BFB2c42162832C7c2f2876a101`) and 6,156,000.00 KHRt, and the current
Identity Authority holds no role on it. Full write-up in `docs/architecture.md` §4 and
`docs/paper-notes.md`.

**The fix, and what it costs.** Make the reference council-settable, or put the
registry behind a proxy at a fixed address, so a later authority inherits assets
instead of forking away from them. This **removes immutability**, which is currently a
real guarantee: today nobody can repoint a token's compliance gate, not even the
council. Settable means a compromised or captured council can point KHRt at a registry
that approves everyone.

Not obviously the right trade. Options worth costing:

- Settable, but only via a timelocked council action with an on-chain order reference,
  so a repoint is visible before it takes effect.
- Immutable reference to a **proxy** the council controls, so the token's gate is
  fixed while the implementation behind it can change. Moves the same power one level
  down rather than removing it.
- Leave immutable and treat redeployment as a migration that must move balances, not
  just addresses. Keeps the guarantee, makes upgrades expensive.

**Scope: eight contracts**, not the two named above — measured, not assumed:

```
contracts/token/KHRStablecoin.sol:28
contracts/land/LandTitleToken.sol:42
contracts/land/LandTitleRegistry.sol:57
contracts/egress/EgressGateway.sol:38
contracts/assets/CSBCollectible.sol:47
contracts/grove/GroveAnchor.sol:64
contracts/grove/GroveTitle.sol:41
contracts/grove/GroveTitleRegistry.sol:63
```

Re-derive rather than trust this list: `grep -rn "immutable identity" contracts/`.

That breadth is itself an argument for the proxy option over making eight references
settable: one fixed address behind a council-controlled proxy leaves all eight
contracts unchanged, where the settable approach adds a privileged setter to each and
eight chances to get the access control wrong.

### 2. Revoking KYC does not stop an address transacting

`IdentityRegistry.revoke()` and `suspend()` change only the attestation. Nothing calls
`setNone` on the `txAllowList` precompile, and entries are granted by hand via
`scripts/allow-dev.js`. A revoked address keeps its ability to send transactions.

**Currently latent:** audited 2026-07-30, zero revoked-or-suspended addresses hold
allow-list access. It becomes real at the first revocation. Re-check any time with
`npx hardhat run scripts/audit-allowlist.js --network csbRemote`.

Two ways to close it, from `docs/architecture.md` §4:

1. Operator procedure — revocation includes `txAllowList.setNone(addr)`. No code
   change, but it is a manual step, and manual steps are what produced this.
2. Give `IdentityRegistry` allow-list admin so `revoke()` removes access atomically.
   Correct, but that contract then gates every transaction on the chain.

### 3. Ingress is ungated

The egress gateway has no inbound counterpart (`docs/fuji-ictt.md` §7). Nothing
inspects or limits what arrives from Fuji. An `IngressGateway` escrow is the design
intent; nothing is built.

**This stops being hypothetical the moment a second asset is bridged in.** The
proposal on the table is testnet USDC from Fuji, which would be the first asset to
enter the perimeter rather than leave it, and it is worth doing for reasons unrelated
to compliance — see item 3b. But note what arrives: `ERC20TokenRemote` is a plain
ERC-20 minted by the bridge, with no identity hook and no freeze. Inside a chain whose
entire claim is that every holder is known, it would be a **bearer asset**. Any address
on `txAllowList` could hold and move it with no attestation at all.

That is the exact mirror of every finding so far. Until now the perimeter held a gated
asset and composability leaked *claims* on it. Here an ungated asset enters and the
perimeter has no say whatsoever — not a leak outward but an unpoliced inflow. The same
asymmetry already noted for prices in `docs/oracle.md` ("the egress gateway governs
value leaving, while nothing governs prices arriving"), now for value itself.

**DECIDED 2026-08-01: accept it, do not modify Ava Labs' contract.** The bridged
token stays the stock `ERC20TokenRemote`, ungated. Two reasons were weighed and
neither is a shrug:

1. **An address that cannot transact can only hold, and a holding it cannot move is
   inert.** Checked against the contract rather than assumed: `send()` and
   `transfer()` both take the holder as `msg.sender`, and moving tokens on someone's
   behalf needs an `approve()` they cannot submit. A non-allow-listed holder is
   therefore frozen in every direction — it cannot spend, cannot bridge out, cannot
   delegate. The perimeter does not govern the *asset*, but the chain still governs
   the *actor*, and for an asset with no off-chain settlement path that is close to
   the same thing.
2. **Reaching `txAllowList` is an act of the authority.** Entries are granted by hand
   (`scripts/allow-dev.js`), so anyone who can move the asset was admitted
   deliberately, and every transfer is on chain and permanent. Visibility and
   traceability survive even though control does not.

The alternative — a `CompliantERC20TokenRemote` overriding `_update` — was designed
and costed and is recorded below, but rejected on the dependency and licensing
grounds in item 3a. **Note that wrapping is not a middle option.** A wrapper offers a
gated alternative nobody is compelled to use; the bridge mints the raw token straight
to the recipient regardless, so the raw token circulates either way. The hole cannot
be closed without controlling the mint.

**Three things this decision accepts, worth having in writing before an incident
rather than during one:**

- **Visibility without remedy.** Tracing works; acting does not. There is no freeze,
  no confiscate, no forced transfer, because those are functions of a contract we did
  not write. A court order that works against KHRt has nothing to act on here. That is
  a defensible position — it is how cash behaves, seizable through courts and physical
  action rather than by the ledger — but it must be stated in advance.
- **Reason 2 is a property of a procedure, not of the system.** Nothing on chain links
  an allow-list entry to an identity; the two live in different places and are
  maintained separately. "We admitted them, so we knew who they were" holds only while
  admission is actually recorded against an attestation. Item 2 is the same gap seen
  from the other side, and `scripts/audit-allowlist.js` is the check — it found zero
  gap addresses on 2026-07-30. Make it routine rather than occasional; the decision
  above depends on it staying clean.
- **Mis-sent funds are unrecoverable.** This is operational, not compliance. Send
  bridged dollars to a wrong or non-allow-listed address and they are stuck
  permanently, because the escape hatch KHRt has — `forcedTransfer` — does not exist
  on a token we did not write. An honest typo is unfixable.

**And the finding this produces, which is worth more than the fix would have been:**

> A sovereign perimeter cannot govern an asset whose issuance it does not control.
> Bridging value in cedes exactly that, and the only lever left is a chain-wide switch
> that excludes the person rather than the asset.

That sits beside "the perimeter governs custody, composability governs exposure" as a
second structural limit — and unlike the first, this one the architecture cannot
solve, only choose.

### 3a. Ava Labs' bridge code is not MIT, and that constrains the fix

Read from `ava-labs/icm-contracts` `LICENSE`, not assumed. It is the **Ava Labs
Ecosystem License v1.1**, and it permits use, modification and redistribution only:

> solely (i) in connection with the Avalanche Public Blockchain platform, having a
> NetworkID of 1 (Mainnet) or 5 (Fuji) … and any subnets linked to the P-Chain … or
> (ii) for non-production, testing or research purposes within the Avalanche
> ecosystem … without any commercial application

and explicitly **not** for "any forks of the Avalanche Authorized Platform" or use "in
any manner not operationally connected to" it. The licence text must be shipped
unmodified wherever the code goes, and violation terminates the grant automatically.

CSB qualifies today on both branches — it is a Fuji-linked L1, and this is research.
Four consequences all the same:

- **This repo is MIT.** Vendoring their code makes it mixed-licence, and a reader who
  sees `LICENSE — MIT` would be misled about the vendored subtree, which cannot be
  relicensed by us.
- **The grant is conditional on staying attached to Avalanche.** For a project about
  sovereignty it is worth knowing that part of the stack is licensed only while the
  chain remains a P-Chain-linked subnet.
- **A copy is frozen.** Upstream security fixes would not reach it, on the one
  component where a bug is stolen collateral rather than a wrong number.
- **It contradicts the method.** Every DeFi finding here rests on *unmodified
  published* upstream code. Copying files and rewriting their import lines is
  modification, at exactly the point where provenance matters most.

If the custom remote is ever revisited, do it as a **git submodule plus
`@nomicfoundation/hardhat-foundry`** (v3.0.4) rather than a copy. That plugin reads
Foundry's `remappings.txt` and `lib/` — which is what their repo uses — so no imports
need rewriting, nothing of theirs enters our tree, the pinned commit hash proves
nothing was changed, and updates are one command. Their licence still governs what is
deployed and still has to be shipped, but "we reference their audited bridge at commit
X" is a materially better position than "we have a modified copy".


### 3b. No second asset, so no real price and no real collateral

Every experiment so far prices KHRt against either itself or a test token nobody
trades. Consequences, all of them limiting:

- Aave has **one reserve**, so "borrow" means depositing KHRt to borrow KHRt, and
  liquidation can only be demonstrated by tightening the liquidation threshold rather
  than by moving a price.
- The Uniswap pool's ratio is whatever it was seeded at, so the TWAP measures a number
  we chose.
- The administered-vs-market divergence in `docs/oracle.md` is therefore vacuous — two
  numbers we set, subtracted.

A bridged dollar stablecoin fixes all three at once, because a riel–dollar rate is a
real quantity with an official figure and a traded figure that genuinely differ. That
is the measurement the whole oracle section exists to make and currently cannot.

Practical notes for whoever does it: it is a **second, independent ICTT pair** in the
opposite direction from the existing one — Home on Fuji wrapping the USDC contract,
Remote on CSB — and the relayer configured in `docs/fuji-ictt.md` §3 already carries
both directions, so it does not need re-deploying. Decimals differ (USDC 6, KHRt 2);
`UniswapV2TwapOracle` already scales by each token's decimals and its tests use
mismatched decimals deliberately, so that part is covered.

---

## The orphaned deployment on 8555

Addresses and measurements in `docs/deployment-status.md`. Deferred because **the live
orphan is verifiable evidence for the finding** — a reviewer can check two `KHRt`
tokens and two registries on chain. Freezing it turns a checkable claim into a
historical one.

### 4. Decide: freeze the orphan, or document and leave it

6,156,000.00 orphaned KHRt across 7 holders, no pause function. Remediable —
`0x8f6aE9fB0993C8691D7FCDFBFC79fbcF5A7BFa8b` holds `DEFAULT_ADMIN_ROLE` and
`ISSUER_ROLE` on both the orphaned token and the orphaned registry. Revoking the 7
attestations in the orphaned registry makes the supply untransferable.

Recommendation: after the paper, or when standing up a fresh chain. Nothing is at
stake — testnet, valueless, all 7 holders are pilot accounts.

Worth remembering when it is done: remediation is reachable **only** because one key
holds every role on both deployments. Implementing the separation of powers properly
would remove this recovery path.

### 5. Check the two orphaned LAND1 tokens

```bash
CSB_TOKEN=0xa7f089C3a465c7e913dE5058e8E4A612663D26Ec npx hardhat run scripts/orphan-check.js --network csbRemote
CSB_TOKEN=0x4f54f0D92ebd6EC6A1d605fDfeDf4D5B41E31E0A npx hardhat run scripts/orphan-check.js --network csbRemote
```

Land titles matter more than test riel if either purports to represent a real parcel
in a demonstration.

### 6. Two tokens answer `symbol()` with `KHRt`

Nothing on chain marks the orphan as superseded. Anything resolving a token by symbol
rather than by address can pick the wrong one. Check the app and any script that does
so.

---

## Chain operations

### 7. Node 3 is not running

`NodeID-LfGX121t7kEmbMWTmcF5RDSP6bWARK87U` (was port 37973). Directory and staking keys
intact; only the process is gone, and it went unnoticed because nothing depended on it.

```bash
avalanche node local start csb-local-node-fuji
bash ops/csb-nodes.sh          # should then show 3 answering
```

### 8. One registered validator — no fault tolerance

Losing node 1 takes connected stake to 0%, which is how the chain went down on
2026-07-28. Registering nodes 2 and 3 is the single most valuable reliability change
available; their staking identities already exist.

**Cost:** each registered validator draws its own continuous ACP-77 fee, so going from
one to three roughly **triples** the drain — and that drain caused the outage. Budget
the P-Chain balance first.

If an `addValidator` run appears to succeed while the P-Chain still shows one
validator, suspect a registration that completed
`initiateValidatorRegistration` on the validator manager and never landed the Warp
message. Recoverable without redeploying. See `docs/deployment-status.md`.

### 9. Validator fee balance needs a calendar reminder, not good intentions

Observed drain: 1.0 AVAX to 0.983 in a few hours. Weeks, not months. Take two readings
a day apart for a real rate before choosing an interval.

```bash
avalanche validator getBalance --fuji --validation-id 2rrjPnaiB3PnatWdkZH37yJqFHBePUupuC5cFPsLXXZja6EBrh
```

### 10. Read load and consensus share one process

Everything — the app, the ops scripts, the relayer's RPC — points at node 1, which is
also the only validator. Pointing the app at node 2 or 3 would isolate read load from
block production. The earlier freezes appeared under sustained activity, so this is
plausibly protective as well as tidy.

---

## Paper

### 11. Make the aToken escape finding an executed result

Currently a gas-corrected `eth_call` simulation: it establishes that the chain permits
the transfer, not that one happened. One transaction fixes it, and gives a citable
hash rather than a claim:

```
aKHRt 0xaCE9cdDb2CFcb92FF613E9330D5241fC66586e8D
send 10 aKHRt -> 0x0Ebb8283bA8C207c832d6043858e98f10915Fbd9
```

**Raise the gas limit to ~250,000.** It needs ~184,500 and a wallet estimate drifts; a
transfer to a zero-balance recipient costs 49% more than to an existing holder
(`docs/defi.md`).

### 12. Two Aave findings are still local

Accrual and liquidation. Accrual needs time to pass with a borrower paying; liquidation
needs a position pushed underwater, which with a hand-set oracle means moving the
price. Both larger than a single transaction. `docs/defi.md` marks which is which.

### 13. No live Aave deployment cost

The market is live on 8555 but nobody recorded what the deploy printed, and
`scripts/aave-live.js` is idempotent so it will not re-measure. The 2,271.89 tRIEL
figure is a **local** measurement. To get a live one: delete the `aave` block from
`app/deployments.json`, re-run, record the total.

### 14. The live market was deployed by an uncommitted script revision

Its recorded `note` field cites "docs/paper §5.4", a path that does not exist;
`scripts/aave-live.js` writes "See docs/defi.md". So the committed script is not
exactly what produced the live addresses. The reserve parameters were re-read from the
chain and match, so this looks cosmetic — but a reproducibility claim should rest on
those readings. If that revision is still on the VM, `git diff` it and close the
question.

---

## Docs hygiene

### 15. `scripts/aave-live.js` header comment is stale

Says "around twenty deployments" and "expect roughly 1,500-2,500 tRIEL". Measured: **31
transactions, ~2,272 tRIEL**. Left untouched because the task that found it was scoped
to documentation and UI copy only. One-line fix.

### 16. Counts move — regenerate, do not quote

206 tests and 29 Solidity files (19 production, 5 interfaces, 4 mocks, 1 library) as of
`HEAD`. Regenerate with `npx hardhat test` and
`find contracts -name '*.sol' | wc -l` rather than citing a document.
