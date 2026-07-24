# Chain configuration reference

Where every rule of the CSB chain lives, what it's currently set to, and how to change it. **Docker sets none of this** — the compose files only configure the *node process* (network, tracked subnet, ports, volumes). The chain's rules live in three layers:

| Layer | Lives in | Changed by | Examples |
|---|---|---|---|
| 1. Genesis | `chain/genesis.example.json`, fixed at chain creation | Network upgrade only | chainId, initial fee config, which precompiles exist, initial balances |
| 2. On-chain runtime | Precompile + contract state | Council/Identity Authority/enforcer transactions (multisig) | live gas fees, who may transact/deploy, KYC, egress policy |
| 3. Node process | Docker env (`AVAGO_*`), optional per-chain JSON | Node operator | network id, tracked subnet, ports, RPC APIs, pruning |

## Layer 1 — Genesis

### `chainId: 8555`

The EVM chain identifier (wallet networks, tx signing). Chosen as a CSB-specific value; before any public phase, verify uniqueness and register it on chainlist.org so wallets resolve it.

### Gas & fees — `feeConfig`

This is where "free gas" is actually implemented:

| Field | Value | Meaning |
|---|---|---|
| `gasLimit` | 20,000,000 | Max gas per block (~20M ≈ hundreds of transfers per block) |
| `targetBlockRate` | 2 | Target seconds between blocks when there's traffic |
| `minBaseFee` | **0** | Floor of the dynamic base fee. **Zero = transactions cost nothing.** On a normal chain this is e.g. 25 gwei; CSB sets 0 and relies on identity-layer anti-spam |
| `targetGas` | 100,000,000 | Gas per ~10s window the fee algorithm treats as "normal load"; above it the base fee rises (from 0, it stays 0 unless raised via feeManager) |
| `baseFeeChangeDenominator` | 48 | How gently the base fee adjusts (higher = slower changes) |
| `minBlockGasCost` / `maxBlockGasCost` | 0 / 10,000,000 | Bounds of the block-production gas cost mechanism |
| `blockGasCostStep` | 500,000 | How fast block gas cost reacts to faster/slower blocks |

`allowFeeRecipients: false` — validators cannot collect fees for themselves. Validator institutions validate as a duty, not for revenue; any (currently zero) fees are burned.

### Precompile activations

Genesis switches on four Subnet-EVM precompiles and sets their **admin addresses** (the `0xC0DE…` placeholders — replace with the council multisig before any real deployment):

| Precompile | Address | Purpose in CSB |
|---|---|---|
| `txAllowList` | `0x0200000000000000000000000000000000000002` | Only admitted addresses can transact at all — chain-level KYC enforcement |
| `contractDeployerAllowList` | `0x0200000000000000000000000000000000000000` | Only vetted deployers can create contracts |
| `feeManager` | `0x0200000000000000000000000000000000000003` | Council can change the entire `feeConfig` live (see below) |
| `contractNativeMinter` | `0x0200000000000000000000000000000000000001` | Administrative minting of the native gas token — no speculative token, no mining |

### Native token & allocations

`alloc` pre-funds the genesis admin with native coin. With `minBaseFee: 0` the native token is almost vestigial (nothing is spent on gas); it exists so the EVM accounting works and so fees *can* be turned on under attack. `contractNativeMinter` can top up system accounts if that ever happens.

## Layer 2 — On-chain runtime configuration

Everything operational is changed by transactions, not by editing files or redeploying Docker:

- **Change gas fees live** — the emergency pressure valve. The council (feeManager admin) calls `setFeeConfig(...)` on `0x…0003` with a new parameter set (e.g. raise `minBaseFee` from 0 during a spam attack, lower it back after). Takes effect next block; no node restarts, no genesis change.
- **Admit/expel accounts** — the Identity Authority's registrar pipeline calls `setEnabled(address)` / `setNone(address)` on the txAllowList (`0x…0002`). Roles: *admin* (can manage roles — council), *manager* (can enable/disable accounts — Identity Authority ops), *enabled* (may transact).
- **Vet contract deployers** — same role model on `0x…0000`.
- **Application policy** — everything else lives in the CSB contracts and is governed as described in `docs/architecture.md` §4: KYC attestations and tiers (`IdentityRegistry`, Identity Authority), freezes (`EnforcementRegistry`, enforcement authority), KHRt issuance and tier caps (`KHRStablecoin`), egress allowlist/caps/pause (`EgressGateway`, council).

Inspect the live values at any time:

```bash
# current base fee (0x0 = free gas)
curl -s -X POST -H 'content-type:application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_gasPrice","params":[]}' $CSB_RPC_URL

# current fee config as the chain sees it
curl -s -X POST -H 'content-type:application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_feeConfig","params":["latest"]}' $CSB_RPC_URL
```

### Hard changes (network upgrades)

Activating a *new* precompile after launch, or changing one's admin set outside its own role mechanism, is a coordinated **network upgrade**: an `upgrade.json` placed in each validator's chain config directory with an activation timestamp, all validators upgraded before that time. On CSB this is a council-scheduled operation — one of the things a permissioned validator set makes routine instead of politically impossible.

## Layer 3 — Node process (what Docker actually configures)

`docker-compose.validator.yml` env vars, all `AVAGO_*`:

| Variable | Meaning |
|---|---|
| `AVAGO_NETWORK_ID` | Which Avalanche network anchors the L1: `fuji` or `mainnet` |
| `AVAGO_TRACK_SUBNETS` | The CSB subnet ID this node validates |
| `AVAGO_HTTP_HOST` / ports | API exposure (9650 localhost-only, 9651 public consensus) |

Optional per-chain node settings (RPC API surface, pruning, state-sync) go in a JSON at `~/.avalanchego/configs/chains/<blockchainID>/config.json` — mount it as a volume if needed. None of these affect consensus or chain rules; two validators with different node configs still agree on every block.

## Quick answers

- **"Where is the gas fee set?"** — `feeConfig.minBaseFee: 0` in the genesis; changeable live by the council through the feeManager precompile.
- **"Is it set in Docker?"** — No. Docker only points a node at the network; if you deleted every compose file the chain rules would be unchanged.
- **"Who can change the rules?"** — Whoever holds the precompile admin roles and contract roles — by design, institutional multisigs under the council. That's the whole governance model: rules change by signed on-chain actions, never by someone editing a config on a server.
