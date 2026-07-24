# Launch checklists

Working checklists for the two launches. Copy each into an issue/tracker and tick items off; an unticked item is a reason not to launch.

## Testnet (Fuji) launch checklist

### Prepare

- [ ] Repo pinned to a tagged commit; `npm test` green (24/24) on that commit
- [ ] Genesis reviewed against [`docs/chain-config.md`](chain-config.md): `chainId` 8555, `minBaseFee` 0, precompile admin addresses = the key you will actually control (testnet: a dedicated deploy key is acceptable; **never** a key also used anywhere else)
- [ ] Fuji AVAX obtained (faucet) on the P-Chain address that will create the L1
- [ ] Coordinator VM provisioned (Elestio or other): 4+ vCPU / 8+ GB / 100+ GB, Docker
- [ ] Firewall: 22 (restricted), 8080 (app), 9651 (validator P2P) — 9650 **not** public

### Create the chain (full commands: [`docs/create-testnet.md`](create-testnet.md))

- [ ] `avalanche blockchain create csb --genesis … --evm --proof-of-authority --vm-version <pinned, e.g. v0.8.0>` (must match the validator image's Subnet-EVM version)
- [ ] `avalanche blockchain deploy csb --fuji` — run inside tmux; P-Chain funded first
- [ ] Recorded: **Subnet ID**, **Blockchain ID**, **VM ID**, RPC URL — stored in the project record and distributed to validator operators with [`docs/validator-manual.md`](validator-manual.md)

### Validators

- [ ] Coordinator's own validator up (`docker-compose.validator.yml`), bootstrapped (`info.isBootstrapped` true)
- [ ] At least 2 further operators onboarded via the validator manual; their NodeID + BLS proofs registered through the Validator Manager
- [ ] Every registered node shows healthy (`health.health`) and the chain produces blocks with one node stopped (liveness margin)

### Contracts & app

- [ ] `docker compose -f docker-compose.app.yml --profile deploy run --rm deployer` against the Fuji RPC (deployer key = txAllowList admin)
- [ ] Contract addresses recorded (`app/deployments.json` backed up)
- [ ] Pilot accounts seeded (`CSB_SEED_ACCOUNTS=1`) **and** enabled in the txAllowList precompile
- [ ] App up behind Elestio TLS; `EXPLORER_PASSCODE` strong (not `csb-demo`); wallet/explorer/admin all load; RPC 9650 unreachable from the internet

### Egress (ICTT)

- [ ] TokenHome (CSB) + TokenRemote (Fuji C-Chain) deployed and registered ([`docs/fuji-ictt.md`](fuji-ictt.md))
- [ ] Both marked system contracts on KHRt; `ICTTBridgeAdapter` wired (gateway + route)
- [ ] Relayer running; one successful round trip CSB → C-Chain → CSB
- [ ] Controls verified live: `TierTooLow`, `DailyCapExceeded`, gateway pause blocks egress

### Rehearsals (each done at least once on Fuji — these gate mainnet)

- [ ] Validator **added** and **removed** via Validator Manager
- [ ] Fee raised from 0 via feeManager and lowered back
- [ ] Account frozen, confiscation executed with order ref, unfrozen
- [ ] KYC revoked and slot re-used; paid quota increase executed
- [ ] Coordinated node upgrade (bump version pair, rolling restart)
- [ ] Validator identity restored from staking-volume backup on a fresh machine

### Wrap

- [ ] Monitoring in place: block height advancing, validator health, relayer liveness, disk
- [ ] All IDs, addresses, keys custody locations, and operator contacts documented in one place

## Mainnet launch checklist

Everything below assumes the **entire testnet checklist is complete**, including all rehearsals.

### Gate (hard blockers)

- [ ] Independent security audit of the contract suite; findings resolved; audited commit tagged and frozen
- [ ] Council legal instrument in force; the operating entity exists and owns the infrastructure
- [ ] Institutional multisigs created and **exercised on Fuji**: council, Identity Authority, enforcement, issuer(-or-council)
- [ ] Genesis finalized: every `0xC0DE…`/test address replaced by the real multisigs; test allocations removed; genesis file hash formally signed off by the council
- [ ] ≥5 validator institutions ready: hardware, key ceremony done, staking backups in custody, NOC monitoring wired
- [ ] Mainnet P-Chain wallet funded and custodied; owner + budget line for creation and continuous fees (~1.33 AVAX/month/validator)
- [ ] Incident runbooks written and rehearsed: gateway pause, fee raise, validator eviction, key compromise
- [ ] KHRt posture decided: launch **dormant** (deployed, zero supply, issuer role parked with council) unless the issuer mandate exists

### Launch

- [ ] `avalanche blockchain deploy csb --mainnet` from the custodied P-Chain key; Subnet/Blockchain/VM IDs recorded and distributed
- [ ] Institution validators up with `AVAGO_NETWORK_ID=mainnet`, bootstrapped, registered, healthy
- [ ] Contracts deployed with real multisig role addresses; **no pilot accounts seeded**
- [ ] Precompile admin rights transferred from the deploy key to the council multisig; deploy key retired (documented destruction/archival)
- [ ] ICTT redeployed against **mainnet** C-Chain; production relayer redundant + monitored
- [ ] Egress daily caps set **near zero** with a written ramp schedule

### Cutover

- [ ] Fuji egress gateway paused; testnet event history exported to the audit archive
- [ ] App repointed to mainnet RPC; DNS switched; explorer confirmed serving mainnet data
- [ ] Identity Authority mainnet onboarding flow live (testnet identities NOT honored — everyone re-registers)
- [ ] Fuji chain retained as permanent staging; policy: every future change rehearses there first

### First month

- [ ] Daily review: validator health, block production, P-Chain fee balance, egress volume vs caps
- [ ] First scheduled key-rotation drill on one multisig
- [ ] Cap-ramp reviews on the written schedule, each one a council decision
