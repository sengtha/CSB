# Moving CSB from testnet to mainnet

The path is **local devnet → Fuji testnet → Avalanche mainnet**. This guide covers the last hop: promoting a working Fuji deployment to production on mainnet.

## The most important fact

**Nothing migrates automatically.** Mainnet is a brand-new chain: new subnet ID, new blockchain ID, empty state. Testnet KYC registrations, balances, and contract state do not carry over — and shouldn't: testnet was rehearsal, with test keys and test riel. Plan for **fresh genesis + re-registration**, not data migration. (If pilot data must be preserved, export it from the testnet explorer/events and re-issue it on mainnet through the normal Identity-Authority/issuer flows — an auditable re-issuance, not a state copy.)

## What changes vs what doesn't

| | Fuji testnet | Mainnet |
|---|---|---|
| Code (contracts, app, validator image) | same | **same — this is the point of the rehearsal** |
| Genesis file | test admin keys ok | **real multisig admins, audited, frozen** |
| `AVAGO_NETWORK_ID` | `fuji` | `mainnet` |
| Subnet / blockchain / VM IDs | testnet values | new values from mainnet creation |
| P-Chain costs | free (faucet AVAX) | **real AVAX** (creation txs + ~1.33 AVAX/month per validator) |
| Role holders | deployer key (pilot mode) | institutional multisigs (council, identity authority, enforcer, issuer) |
| Validators | a few cloud VMs | institution-operated nodes, in-country data centers, HSM-backed keys |
| ICTT counterpart | Fuji C-Chain | Mainnet C-Chain (real value crosses the boundary) |
| Relayer | avalanche-cli test relayer | state-operated, redundant `icm-relayer` service |
| Egress caps | generous for testing | **start near zero, ramp with confidence** |

## Pre-flight checklist (do not launch without)

1. **Contract audit.** Independent security audit of the contract suite; freeze the audited commit. Mainnet KHRt is real money the day the issuer mandate exists.
2. **Genesis finalization.** Replace every `0xC0DE…` placeholder with the real council multisig; remove test allocations; re-verify `chainId` registration; council formally signs off the genesis file hash.
3. **Multisig ceremonies.** Create the institutional multisigs (council, identity authority, enforcement, issuer), test them on Fuji first, document signer lists and rotation procedure (officeholder-change runbook).
4. **Validator fleet ready.** Target ≥5 institutions at launch. Each: hardware in an in-country data center, keys generated in an institutional key ceremony, staking-volume backup in custody, monitoring wired to the NOC.
5. **P-Chain funding.** A funded, custodied P-Chain wallet for creation fees and the continuous validator fees; a top-up procedure with an owner and a budget line.
6. **Operational rehearsal on Fuji.** At minimum once: validator addition *and removal*, a feeManager fee raise/lower, a gateway pause/unpause, an ICTT round trip, a coordinated node upgrade, and a restore-from-backup of a validator identity.
7. **Decide KHRt's decimals, and decide it here.** The riel is a **zero-decimal currency** — no circulating subunit, prices quoted in whole riel. KHRt carries **2**, so one raw unit is 1/100 riel: a quantity nobody can pay in cash. That is a defensible ledger-precision choice, not an oversight, but it must be a stated decision before real issuance rather than an inherited default.

   The trade is not symmetric. **Zero decimals is faithful to the currency and hostile to every percentage-based mechanism on the chain**: a 1% levy rounds to nothing below 50 riel, and Aave's per-second interest index would take months to move a small depositor's balance by one whole riel — the accrual already measured on 8555 needs ~7,250 intervals to move a single 0.01 unit, which at 0 decimals becomes ~725,000. **Two decimals buys representability and costs faithfulness**: the ledger can express amounts that cannot be settled in cash, and rounding rules at the cash boundary become somebody's written policy rather than an accident.

   Whichever is chosen, it is effectively permanent. `decimals()` is `pure`, so changing it means redeploying the token — and a redeploy **forks the compliance perimeter** rather than migrating it (item 1 in `docs/todo.md`, demonstrated live on 8555). Get it right before the first issuance, not after.

8. **Legal.** The governing legal mandate (hypothetical: e.g. a decree establishing the council) in force; KHRt issuance still gated on the issuer mandate — mainnet can launch with the stablecoin dormant (contracts deployed, ISSUER_ROLE with the council, zero supply) until the mandate exists.

## The bridge: what mainnet actually requires

Ingress failed on the testnet deployment, and the reason is worth planning around
rather than rediscovering. Both directions are governed by one protocol rule.

### The rule

An ICM message is signed by the **source** chain's validator set, using BLS, and the
**destination** chain's Warp precompile verifies the aggregate against a stake quorum.
From `subnet-evm/precompile/contracts/warp/config.go`:

```go
WarpDefaultQuorumNumerator uint64 = 67
WarpQuorumNumeratorMinimum uint64 = 33
WarpQuorumDenominator      uint64 = 100
```

So delivering a message **from** chain X requires collecting signatures from validators
holding **≥67% of X's stake** (by default), and the relayer collects them by opening
P2P connections to those validators and asking each one directly. There is no
intermediary and no cache to fall back on: **if the relayer cannot reach the
validators, the message cannot be delivered.**

### What that means in each direction

| | Signed by | Reached how | Fragility |
|---|---|---|---|
| CSB → C-Chain (egress) | CSB's own validators | inside the state's network | our operational problem |
| C-Chain → CSB (ingress) | Avalanche's validators | across the public internet | **not our infrastructure** |

Measured on 2026-08-01 (`docs/fuji-ictt.md`): CSB's side reached quorum on the first
attempt with one validator of weight 100. The Fuji side reached 8e9 of 3.64e16 — three
validators out of ~85 — and never came close. Mainnet's Primary Network is far larger
still.

### Requirement 1 — CSB must have enough validators, and they must be reachable

With **one** validator, 67% of CSB's stake *is* that one node. Every KHRt egress then
depends on a single machine being up and reachable by the relayer. That is a
single point of failure for the entire outward bridge, separate from block production.

The ≥5-validator target in the pre-flight checklist covers this, with one addition:
the relayer must be able to reach **≥67% of validator stake at all times**, so
validator P2P endpoints must be stable and reachable from wherever the relayer runs.
Losing two of five nodes stops blocks *and* stops the bridge.

### Requirement 2 — the relayer host must be a real network participant

This is what the testnet deployment lacked. The relayer runs its own P2P stack; it is
not enough for the *chain* to be healthy. The host needs:

- a **public static IP**, with `--public-ip` set correctly (or 1:1 NAT configured)
- **inbound TCP on the staking port open** — peering is largely inbound, and a host
  nothing can dial reaches only the few peers it dials itself
- unrestricted **outbound** TCP to arbitrary peers on that port
- `ulimit -n` raised (≥32768) — peering with a large validator set needs the sockets
- a **fully bootstrapped local AvalancheGo** (P, X and C), so `p-chain-api` and
  `info-api` point at localhost rather than a rate-limited public endpoint

An avalanche-cli *local cluster* satisfies none of this by design: it binds to
localhost, which is correct for development and fatal for relaying.

### Requirement 3 — decide the inbound quorum deliberately

`quorumNumerator` is CSB's own genesis parameter, settable from **33 to 100**. It
governs how much of the *foreign* chain's stake must sign a message CSB will accept.

- **67 (default)** — the standard assurance, and the hardest to reach.
- **33 (minimum)** — halves the stake a relayer must contact, and halves the cost of
  forging an inbound message.

This is a genuine sovereignty decision rather than a tuning knob: it sets how much of
someone else's validator set CSB trusts before admitting foreign value. Decide it, and
write down why. It is fixed at genesis for practical purposes.

### Requirement 4 — run more than one relayer

Relayers are stateless with respect to each other and duplicate deliveries are
rejected harmlessly, so ≥2 on separate hosts removes the single point of failure. A
bridge with one relayer is a bridge with an operator-shaped outage waiting in it.

### What this costs, honestly

Egress depends only on infrastructure the state runs. **Ingress depends on reaching
validators the state does not operate and cannot compel**, over the public internet.
No configuration removes that dependency; it can only be met with a properly
networked host, or accepted as a limit. A sovereign chain governs what leaves and
depends on the outside world for what arrives.

## Migration steps

### 1. Create the mainnet L1

From the operator machine (P-Chain key/Ledger holding real AVAX):

```bash
avalanche blockchain create csb --genesis chain/genesis.json --evm --proof-of-authority
# validator-manager owner = council multisig
avalanche blockchain deploy csb --mainnet
avalanche blockchain describe csb   # record: Subnet ID, Blockchain ID, VM ID
```

Distribute the three IDs to all institutions — they go into each validator's `.env`.

### 2. Bring up validators

On each institution node:

```bash
# .env: AVAGO_NETWORK_ID=mainnet, CSB_SUBNET_ID=<mainnet subnet>, CSB_VM_ID=<mainnet vm id>
docker compose -f docker-compose.validator.yml up -d --build
```

Mainnet notes: the node first bootstraps against the Avalanche Primary Network (hours-to-days; size disks accordingly). Post-Etna L1 validators can run **partial sync** (`AVAGO_PARTIAL_SYNC_PRIMARY_NETWORK=true`) — they track the P-Chain without validating the Primary Network, which keeps hardware needs modest. Each node sends its NodeID + BLS proof to the council; the council registers validators through the Validator Manager (paying the continuous AVAX fee).

### 3. Deploy contracts

```bash
export CSB_RPC_URL='http://<node>:9650/ext/bc/<mainnet blockchainID>/rpc'
export CSB_CHAIN_ID=8555
export CSB_DEPLOYER_KEY='<txAllowList-admin deploy key>'
export COUNCIL_ADDR=<council multisig> IDENTITY_ADDR=<identity-authority multisig> \
       ENFORCER_ADDR=<enforcement multisig> ISSUER_ADDR=<issuer or council>
docker compose -f docker-compose.app.yml --profile deploy run --rm deployer
```

Do **not** seed pilot accounts on mainnet. After deployment, the deploy key's admin rights on the precompiles are handed to the council multisig and the key is retired.

### 4. Reconnect the egress path

Redeploy ICTT against mainnet: `ERC20TokenHome` on CSB, `ERC20TokenRemote` on the **mainnet** C-Chain, `registerWithHome()`, mark both as system contracts on KHRt, deploy `ICTTBridgeAdapter`, set the route with the **mainnet C-Chain blockchainID**, point the gateway policy at it (see `docs/fuji-ictt.md` — identical flow, mainnet addresses). Start the production relayer (redundant instances, monitored). **Set the initial daily caps near zero** and ramp them deliberately.

### 5. Cutover

1. Announce end-of-life for the Fuji deployment; pause its egress gateway.
2. Export the testnet event history (explorer data) for the audit archive.
3. Point the app at mainnet (`CSB_RPC_URL`), switch DNS.
4. Begin mainnet onboarding through the real Identity Authority flow — testnet identities are **not** honored; everyone re-registers.
5. Keep the Fuji chain alive as the permanent staging environment: every future upgrade (contract, precompile, node version) rehearses there first, forever.

### 6. Post-launch

- Monitoring: validator health, block production, P-Chain fee balance, relayer liveness, egress volumes vs caps.
- Incident runbooks tested on Fuji: gateway pause, fee raise, validator eviction, key compromise.
- Upgrade cadence owned by the council; validators upgrade inside the compatibility window.

## Rollback reality

There is no rolling back a launched mainnet with real registrations on it — contingency is *containment*, not reversal: pause the gateway (nothing of value leaves), raise fees (spam stops), freeze accounts (incidents contained), and fix forward via the rehearsed upgrade path. This is why step 6 of the pre-flight checklist is not optional.
