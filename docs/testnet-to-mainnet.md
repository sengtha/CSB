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
