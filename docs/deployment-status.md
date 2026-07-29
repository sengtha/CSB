# CSB deployment status — Fuji testnet

**Status:** LIVE on Avalanche Fuji · redeployed 2026-07-24 on a fresh VM, running **three nodes but ONE registered L1 validator** (see the validator-set section below — this was recorded as "three validators" until 2026-07-28, when querying the P-Chain showed otherwise). **Wallet KHRt transfer, the Fuji ICTT bridge in both directions, and unmodified Uniswap V2 and Aave V3 all verified working end-to-end.**

This is the running record of the CSB testnet: what exists, where, and how to operate it. Public identifiers and contract addresses only — **no private keys or passcodes live in this file** (those are in `~/.avalanche-cli/key/`, `app/deployments.json`, and the operator's env, all off-repo).

## Chain identity

| | |
|---|---|
| Network | Avalanche **Fuji** (testnet) |
| EVM Chain ID | **8555** (`0x216b`) |
| Subnet ID | `fgNiKVRTRJFZbCzSUPJMix6YdG2HfpXGf1LP9rQ58b5TU9mJL` |
| Blockchain ID | `299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW` |
| VM ID | `koLRzStcoE4fZ6V1DtXJCYMVWctdrdfpR6Y5egzFbURXRSvVv` |
| Validator Manager | V2 PoA, owned by the deployer key (Governing-Council slot in production) |
| Validators | **3** (avalanche-cli local cluster `csb-local-node-fuji`) — see Infrastructure. Multi-validator from birth so block production keeps going under load. |
| Native token | **tRIEL** (10,000,000 allocated to the deployer at genesis) |
| Gas | **~1 tRIEL (1 riel) per ordinary payment** — fee floor ≈ 47,619 gwei, so a 21,000-gas transfer costs 1 tRIEL and heavier transactions cost proportionally more. Set with `scripts/set-gas-price.js`. |
| Gas fees go to | **The public-good fund, not burned** — RewardManager (`0x…04`) routes every transaction's fee to the charity address. Set with `scripts/set-reward-address.js`. |
| Version pair | AvalancheGo **v1.14.1** / Subnet-EVM **v0.8.0** (both plugin protocol 44 — the only released working pair; see `docs/create-testnet.md`) |
| Local RPC | `http://127.0.0.1:9650/ext/bc/299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW/rpc` |

## Infrastructure

| | |
|---|---|
| Host | Elestio VM (host `cicd-upecy-u70984`; repo at `/opt/csb`, Ubuntu, Docker) |
| Nodes (3), validators (**1**) | avalanche-cli local **cluster `csb-local-node-fuji`**. Node 1 `NodeID-BoRS383b4Z9ZdsJSVUcnrXNCXh5Qj93ux` (port **9650**, primary API) — **the only registered L1 validator** · Node 2 `NodeID-7bR7RPuFvqKqz6iJghvhcuyDSwTovV7xk` (port 32865) · Node 3 `NodeID-LfGX121t7kEmbMWTmcF5RDSP6bWARK87U` (port 37973). Nodes 2 and 3 track the chain and contribute no stake. Measured 2026-07-28: node 2 serves the ICM relayer's **websocket** (one established connection — the relayer subscribes there for new blocks while using node 1 for RPC); node 3 has **no connections at all** and is a warm spare. Everything else — the app, the ops scripts, the relayer's RPC — points at node 1, which is also the validator, so read load and consensus share one process. **Always operate this one cluster.** Verify the validator set rather than trusting this table: `platform.getCurrentValidators` with the subnet ID (command in the validator-set section). |
| Staking key backup | `~/csb-backup.tgz` (staker.key/crt + BLS signer + deployer key) — pulled off the VM. Each validator's staking identity lives under `~/.avalanche-cli/local/csb-local-node-fuji/<NodeID>/staking/`. |
| App server | `app/server.js` on port **8080** (gated wallet/explorer/admin), passcode via `EXPLORER_PASSCODE` env |
| Deployer / admin key | `csb-deployer` → **`0x8f6aE9fB0993C8691D7FCDFBFC79fbcF5A7BFa8b`** — precompile admin, contract deployer, KHRt issuer, validator-manager owner. **TESTNET ONLY — never reuse on mainnet.** |

## Precompiles (all admin = deployer address)

| Precompile | Address | Purpose |
|---|---|---|
| Transaction Allow List | `0x0200000000000000000000000000000000000002` | Chain-level KYC gate — only enabled addresses transact |
| Contract Deployer Allow List | `0x0200000000000000000000000000000000000000` | Only vetted addresses deploy contracts |
| Fee Manager | `0x0200000000000000000000000000000000000003` | Live fee config; sets the ~1 tRIEL-per-payment price (`scripts/set-gas-price.js`) |
| Native Minter | `0x0200000000000000000000000000000000000001` | Administrative tRIEL minting (also backs RielConverter wrap/unwrap) |
| Reward Manager | `0x0200000000000000000000000000000000000004` | Gas-fee distribution — enabled so fees are **routed, not burned** (set a reward address to fund public good) |
| Warp | (activates ICM) | Interchain messaging / ACP-77 L1 |

## Deployed contracts (CSB suite)

Recorded in `app/deployments.json`. Addresses on the CSB chain:

| Contract | Address |
|---|---|
| IdentityRegistry | `0xcefED86aEA46cb5d772365D98a9980a36040A4AD` |
| EnforcementRegistry | `0x501B9BEcC2cAE831C547F961e5D84D832793BDb7` |
| KHRStablecoin (KHRt) | `0xE3Fa15A625Ba66D69A683E42b78a993770320799` |
| EgressGateway | `0x8c6bB6291214210eba9387befF03E725323df925` |
| MockBridgeAdapter | `0x067322daE120a142c37B2CC36868Ae71F306721F` |
| RielConverter (wrap tokenized RIEL ↔ tRIEL) | `0xEe001Bc1fE519932CbF46ab37098D36312c44F45` |
| RielPay (native tRIEL payments + public-good levy) | `0xC357C7d39C9377AdaC24296610a1a379beEa0Ef4` |

Interop (deployed by avalanche-cli):

| | Address |
|---|---|
| ICM Messenger (Teleporter) | `0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf` |
| ICM Registry | `0xD1760194F90e8265e4F269Ab19725A338484eE80` |

Roles at deploy time all point to the deployer (pilot mode): council, identity authority, enforcer, issuer. In production these become distinct institutional multisigs.

## Pilot accounts (seeded — keys in `app/deployments.json`, DEV ONLY)

| Name | Address | Tier | txAllowList |
|---|---|---|---|
| Sokha | `0x228C3A091CbB2FE7403C2a170f5104700e22e2ac` | 2 (full KYC) | enabled |
| Dara | `0xfc0E5481cEa367C15dd14CA7f31Ef40a121a8929` | 1 (capped) | enabled |
| Vanna | `0x983482601deE50782C3475854B967A09Ec571bA5` | none | not enabled (rejection cases) |
| Charity (illustrative public-good recipient) | `0xE77566de0F9B7c21Ae33228ea9329Cc9931e6863` | 2 (full KYC) | enabled, levy-exempt |

> The charity account is a **placeholder** used to demonstrate the public-good levy. Nothing here is endorsed by, affiliated with, or arranged with any real organisation — it is a worked example on a testnet.

## Money and fee policy (decided)

1. **Gas costs about 1 tRIEL per payment.** The EVM prices per unit of gas, not
   per transaction, so the floor is set so a 21,000-gas transfer costs exactly
   1 tRIEL; a KHRt transfer (~65–100k gas) costs a few riel. "1 riel per
   transaction" is the price of an ordinary payment, not a flat cap.
2. **A tokenized riel exists from day 1.** Issuance is a government function and
   deliberately not tied to one institution — the central bank is one possible
   issuer among several. KHRt ships as the reference issuer, approved in the
   RielConverter at deploy time, so conversion works in both directions on day 1
   rather than as a later phase. *(Placeholder roles — no real institution is
   implied or committed.)*
3. **All gas fees go to the public-good fund.** Routed to the charity address via
   RewardManager, so every transaction on the chain contributes — not only KHRt
   payments.

Applying 1 and 3 on the live chain:

```bash
cd /opt/csb && source ops/csb-env.sh   # RPC, chain id, gas price, deployer key
                                       # prints "deployer 0x8f6aE9fB…b ✓"

# the fund has to EXIST before fees can be routed to it — this creates the
# charity account and records it in deployments.json
npx hardhat run scripts/enable-charity-levy.js --network csbRemote

# 3. then route gas fees to it, BEFORE raising the fee, or the fees charged in
#    between go to Subnet-EVM's blackhole and are destroyed
npx hardhat run scripts/set-reward-address.js --network csbRemote

# 1. finally price gas at ~1 tRIEL per transfer
npx hardhat run scripts/set-gas-price.js --network csbRemote

# top pilot accounts up — 10 tRIEL only buys ~2 payments once gas is priced
npx hardhat run scripts/fund-native.js --network csbRemote
```

**Order matters, in two places.** The charity must exist before the reward
address can point at it, and the reward address must be set before the fee is
raised — otherwise the fees charged in between are destroyed.

**"Not burned" is not the same as "not the zero address."** When rewards are
disabled, `currentRewardAddress()` returns Subnet-EVM's blackhole
(`0x0100…0000`), not `0x0`. A check testing only for zero reports burned fees as
a pass — which is exactly what happened here, with over 1,000 tRIEL destroyed
before it was noticed. `verify-policy.js` now recognises the blackhole.

Check it is actually in force on the chain (read-only, sends nothing):

```bash
npx hardhat run scripts/verify-policy.js --network csbRemote
```

See what the fund has raised across both streams:

```bash
npx hardhat run scripts/fund-report.js --network csbRemote
```

Or on the website: **`/fund.html`** — a public transparency page showing the
running total, both income streams, and where each riel came from. It is the one
page served **without the passcode**, backed by a narrow read-only `/fund`
endpoint that exposes this single address and is not an RPC passthrough. That is
deliberate: everywhere else the app restricts each user to their own data, and a
public fund is the opposite case.

Verified live on the current chain: fee floor 47,619 gwei (a transfer costs
1.0000 tRIEL), KHRt approved in the RielConverter, and `currentRewardAddress` =
the charity `0xE77566de0F9B7c21Ae33228ea9329Cc9931e6863`.

### The 100 tRIEL node fee cap (must be raised for the 1-riel policy)

Subnet-EVM refuses any transaction whose total fee exceeds `rpc-tx-fee-cap`,
default **100**. That rail assumes a native token worth real money; here 100
tRIEL is about 2.5 US cents. Combined with the 1-riel-per-transfer price, an
ordinary contract deployment (~2.1M gas) costs slightly *more* than the cap and
fails with `tx fee exceeds the configured cap` — a trivial amount blocked by a
safety limit meant for a different scale of token.

It is close-run rather than wildly over: a 2,107,273-gas deployment costs
**100.35 tRIEL** against a 100 tRIEL cap — 0.35% too much.

**Durable fix** (needs a restart):

```bash
node ops/csb-patch-chain-config.js            # dry run — shows the diff
node ops/csb-patch-chain-config.js --write    # apply (backs up config.json.orig)
export PATH=$PATH:$HOME/bin
avalanche node local stop csb-local-node-fuji && avalanche node local start csb-local-node-fuji
```

**avalanche-cli does not read `configs/chains/<id>/config.json`.** It passes the
whole chain config inline, base64-encoded *twice*, in each node's own
`config.json` under `flags.chain-config-content`:

```
flags["chain-config-content"]  = base64 of
  { "<blockchainID>": { "Config": base64 of
      { "log-level": …, "eth-apis": [ … ] } } }
```

A file written into `configs/chains/` is read by nobody and behaves exactly like
a setting that has no effect — which is what made this take several rounds to
find. `ops/csb-chain-config.sh` writes those (ignored) files and is kept only for
clusters that do use a chain-config directory; on this one, use the patcher.

Verify afterwards with `txpool_status`: both settings live in the same blob, so
if the txpool API answers, the fee cap was lifted too.

**No-restart alternative** — drop the gas price for the duration of the
deployment and put it back afterwards:

```bash
bash ops/csb-redeploy.sh
```

Nothing about the fee *policy* changes; only what the chain charges for those
few minutes, restored on exit even if a step fails. Order is handled inside the
script because it is easy to get wrong — the floor has to come down before the
submitted gas price does, and go back up after it.
It sets `rpc-tx-fee-cap: 0` and, in the same restart, adds `internal-txpool` so
the watchdog can finally distinguish an idle chain from a wedged one.

**Do not expose the txpool API publicly** — mempool contents leak pending
transactions. Port 9650 stays on localhost.

**Keep `CSB_GAS_PRICE_WEI` above the floor.** `hardhat.config.js` prices script
transactions at a fixed 55,000 gwei, chosen to sit ~15% above the 47,619 gwei
floor. If the fee policy changes, this must change too — a script submitting
below the floor produces a transaction that never mines, which looks exactly
like the chain being wedged. `set-gas-price.js` prints the value to use.

## Public-good levy (worked example)

KHRt carries an optional per-transfer levy: **1 KHRt of every KHRt transfer** is
routed to the charity address above, on-chain, with no extra step for the sender.
Mints, burns, enforcement moves, system contracts, the recipient itself, and any
explicitly exempt address are all excluded, as is any transfer at or below the
levy amount. Configure it with `scripts/enable-charity-levy.js`, or from the
admin console → Council → *Public-good levy (KHRt)*. The wallet shows the
donation on the payment panel and the running total raised.

## What works today

- Chain producing blocks on a **3-validator** cluster; RPC answers `eth_chainId` = `0x216b`.
- Full contract suite live; Sokha/Dara KYC-active, txAllowList-enabled, and funded with tRIEL.
- **Wallet KHRt transfer (Sokha → Dara) verified end-to-end through the gated app.**
- **RielPay** — pay in native tRIEL directly, so the chain is usable before any tokenized riel exists.
- **RielConverter** — wrap an approved tokenized riel 1:1 into native tRIEL (token locked, tRIEL minted) and unwrap back (tRIEL burned, token released).
- **Per-transfer public-good levy on KHRt** enabled (1 KHRt → charity address).
- Gated app UI (explorer/wallet/admin) serving the live chain on :8080; passcode login works.
- Self-service **scoped RPC** — any KYC-active address can mint its own read-filtered RPC URL by signing a challenge; council can revoke from the admin console.
- Gas priced at ~1 tRIEL per ordinary payment, with all gas fees routed to the public-good fund via RewardManager (see Money and fee policy).
- ICM Messenger/Registry deployed, but the **relayer is not funded** (chose "Not now" at deploy) — cross-chain egress delivery needs it funded first.

## Operate it

**Load the operator environment first.** `ops/csb-env.sh` exports the RPC URL,
chain id, gas price and deployer key, reading the key from the avalanche-cli
keystore so it is never typed or pasted:

```bash
cd /opt/csb && source ops/csb-env.sh
# csb-env: deployer 0x8f6aE9fB0993C8691D7FCDFBFC79fbcF5A7BFa8b ✓
```

It derives the address from the key and warns if it isn't the recorded deployer
— catching a wrong or stale keystore before it's used to send an admin
transaction. Then any admin script is just
`npx hardhat run scripts/<name>.js --network csbRemote`.

**Never paste the deployer key into a chat, a commit, a ticket, or a shell you
don't control.** It is the chain's root authority — precompile admin, KHRt
issuer, validator-manager owner. Anywhere it lands is somewhere it must be
rotated from. This one is testnet-only and must never be reused on mainnet.

```bash
# --- on the VM ---
export PATH=$PATH:$HOME/bin
export RPC=http://127.0.0.1:9650/ext/bc/299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW/rpc

# chain alive?
curl -s -X POST -H 'content-type:application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' $RPC

# (re)start the app server
pkill -f 'app/server.js'; cd /opt/csb
EXPLORER_PASSCODE=<your-passcode> CSB_RPC_URL=$RPC nohup node app/server.js > /tmp/app.log 2>&1 &

# fund pilot accounts with native tRIEL so the wallet "Send payment" works
# (they hold KHRt but need tRIEL to pay gas — see Troubleshooting below):
CSB_RPC_URL=$RPC CSB_CHAIN_ID=8555 CSB_DEPLOYER_KEY=<deployer-key> \
  npx hardhat run scripts/fund-native.js --network csbRemote

# after a VM reboot, the validator cluster must be restarted. All three
# validators live in the ONE cluster 'csb-local-node-fuji' — starting it starts
# all of them. Never create a second cluster for this chain.
avalanche node local list                        # shows all 3 nodes + health
avalanche node local start csb-local-node-fuji
```

Browser access: your Elestio host over HTTPS (passcode-gated). **Easiest login: visit any page with the passcode in the URL once** — `https://<your-elestio-host>/explorer.html?pw=<passcode>` — it sets the session cookie and redirects (no form field). The passcode box also works. For a shared HTTPS link, front port 8080 with a TLS reverse proxy — see `docs/ssl.md` (Elestio proxy or Caddy), then relaunch the app with `COOKIE_SECURE=1`.

## Next steps (testnet checklist continues)

1. Watch that the 3-validator chain keeps producing blocks over days, not minutes — the earlier chains wedged only after sustained use. Install the watchdog (below) so a stall is caught automatically instead of during a demo.
2. Decide the gas policy: leave gas near-free, or charge a small fee and route it to the public fund with the RewardManager precompile (`setRewardAddress`).
3. Real ICTT egress to Fuji C-Chain (`docs/fuji-ictt.md`) — first token across the governed gateway onto a public chain.
4. Remaining rehearsals: freeze/confiscate, validator remove, fee raise/lower (partly done), backup restore, coordinated upgrade.
5. Invite an external validator operator using `docs/validator-manual.md` (the Docker validator in `docker-compose.validator.yml`, ports 9652/9653, is the template for an off-VM operator).

## Watchdog

`ops/csb-watchdog.sh` probes chain liveness every 5 minutes and restarts the
validator cluster when it is genuinely stuck. It deliberately does **not** treat
a flat block height as a stall on its own — Subnet-EVM only builds a block when
there is something to include, so an idle chain legitimately sits still. It acts
only when the height is flat *and* either transactions are waiting in the mempool
or the node reports unhealthy.

```bash
# --- on the VM, as root ---
cd /opt/csb && git pull
install -m 755 ops/csb-watchdog.sh /usr/local/bin/csb-watchdog
cp ops/csb-watchdog.service ops/csb-watchdog.timer /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now csb-watchdog.timer

# dry run first — alerts, never touches the cluster
CSB_WATCHDOG_RESTART=0 /usr/local/bin/csb-watchdog

systemctl list-timers csb-watchdog.timer
journalctl -u csb-watchdog -n 50
```

If the L1 is ever redeployed, update `CSB_RPC_URL` in
`/etc/systemd/system/csb-watchdog.service`.

### Enabling the mempool signal (recommended)

The watchdog needs to see whether transactions are waiting, or it cannot tell an
idle chain from a wedged one — the exact failure this chain has had before. It
tries `txpool_status` first, then falls back to counting transactions in the
`pending` block. **Subnet-EVM exposes neither by default**, so out of the box the
watchdog covers RPC-down and unhealthy-node but *not* a wedged chain, and says so
in its log.

To close the gap, add `internal-txpool` to the node's `eth-apis`. Chain config
for an avalanche-cli local cluster lives per node:

```bash
BC=299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW
for n in ~/.avalanche-cli/local/csb-local-node-fuji/NodeID-*; do
  d="$n/configs/chains/$BC"; mkdir -p "$d"
  cat > "$d/config.json" <<'JSON'
{
  "eth-apis": [
    "eth", "eth-filter", "net", "web3",
    "internal-eth", "internal-blockchain", "internal-transaction",
    "internal-txpool"
  ]
}
JSON
done
avalanche node local stop csb-local-node-fuji
avalanche node local start csb-local-node-fuji
curl -s -X POST -H 'content-type:application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"txpool_status","params":[]}' $RPC; echo
```

This requires a cluster restart to take effect. Weigh that against this chain's
history: a restart is itself the operation that has surfaced trouble before, so
do it deliberately while nothing depends on the chain — not before a demo. It
also doubles as the reboot-recovery rehearsal that has to pass eventually
anyway. **Do not expose the txpool API on any public-facing RPC** — mempool
contents leak pending transactions; see the RPC-privacy section of
`docs/validator-manual.md`.

## Backups (keep off the VM)

- `~/.avalanche-cli/key/csb-deployer.pk` — chain root authority.
- `app/deployments.json` — contract addresses + pilot keys.
- **Validator staking identities** — `~/.avalanche-cli/local/csb-local-node-fuji/<NodeID>/staking/staker.key` + `staker.crt`, for all three NodeIDs. Together these keys **are** the L1's validator set; lose enough of them and the chain cannot reach quorum to bootstrap or to register replacements. Back them all up off the VM. (This is exactly what went wrong once: a stop/start landed on a *different* cluster with a new NodeID, and the L1 sat at "0% stake connected / context deadline exceeded" until the original cluster was restarted.)
- (validator identity) `csb_avalanchego-staking` Docker volume, if an off-VM Docker validator is registered.

## Troubleshooting

**Wallet "Send payment" does nothing / fails with an insufficient-funds error.**
The pilot accounts (Sokha/Dara) were seeded with KHRt but no native **tRIEL**.
Every EVM transaction — including a KHRt transfer — makes the node reserve
`maxFeePerGas × gasLimit` from the sender's *native* balance up front, and the
effective gas price on this chain is not actually zero (setting the fee floor to
0 does not force the node's fee suggestion to 0). With 0 tRIEL the transfer
reverts before it runs. Fix: give the accounts a little tRIEL with the Native
Minter (deployer is admin):

```bash
export PATH=$PATH:$HOME/bin
export RPC=http://127.0.0.1:9650/ext/bc/299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW/rpc
cd /opt/csb
CSB_RPC_URL=$RPC CSB_CHAIN_ID=8555 CSB_DEPLOYER_KEY=<deployer-key> \
  npx hardhat run scripts/fund-native.js --network csbRemote
```

Then reload the wallet and send again. (`scripts/seed-accounts.js` now funds
native gas at seed time too, so future deployments won't hit this.)

**A transaction (or `fund-native.js`) hangs and never confirms.** After the fee
floor is set to 0, this chain's *effective* base fee still jumps well above it
(Subnet-EVM block gas cost — ~170 gwei observed), and ethers' automatic fee
estimate can under-price a tx so it sits unmined in the mempool and `wait()`
hangs forever. Both `fund-native.js` and the wallet now price transactions
explicitly, far above the current base fee (harmless — the node only charges the
real base fee), and `fund-native.js` times out after 90s instead of hanging. If
a tx is reported stuck, just re-run the script.

**Block height frozen — RPC answers, but `eth_blockNumber` never advances and no
tx ever mines.** This was the defining failure of the earlier single- and
two-validator chains. It is *not* a fee problem, a version mismatch, a validator
balance problem, or a clock problem — all of those were ruled out, and neither a
restart nor adding a validator afterwards recovered a chain once wedged. Check
liveness first, and check every node in the cluster:

```bash
avalanche node local list                        # all 3 nodes should be Running/Healthy/Bootstrapped
curl -s 127.0.0.1:9650/ext/health | head -c 400  # look for percentConnected / disconnectedValidators
for i in 1 2; do
  curl -s -X POST -H 'content-type:application/json' \
    --data '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' $RPC; echo; sleep 5
done                                             # the two numbers must differ
```

If height is frozen, **check the validator fee balance before restarting** — a
validator deactivated for a zero balance produces exactly this symptom, and a
restart cannot fix it (see "The fee balance is a deadline" below, and
`docs/incident-2026-07-28.md`). Restarting a chain whose validator is inactive
wastes time and destroys the evidence.

If balances are healthy and height is still frozen, restart the cluster
(`avalanche node local stop csb-local-node-fuji && avalanche node local start
csb-local-node-fuji`) — once, and then leave it alone; competing starts are their
own failure mode.

**Chain won't bootstrap after a restart: "context deadline exceeded" / health shows
`not connected to enough stake: connected to 0.000000%`.** The nodes that came up
are not the L1's registered validators. Confirm the NodeIDs from `avalanche node
local list` match the three recorded under Infrastructure above, and that you
started the `csb-local-node-fuji` cluster rather than creating a new one — a
freshly created cluster gets *new* NodeIDs that the L1 has never registered and
can therefore never bootstrap it.

## Validator set — three nodes, ONE validator

This section was wrong until 2026-07-28. It said the chain ran three validators.
It runs three *nodes* and one *validator*, which are different things: a node that
tracks the chain contributes no stake, and only validators registered on the
P-Chain do. Check it, do not trust this file:

```bash
curl -s -X POST -H 'content-type:application/json' --data '{
  "jsonrpc":"2.0","id":1,"method":"platform.getCurrentValidators",
  "params":{"subnetID":"fgNiKVRTRJFZbCzSUPJMix6YdG2HfpXGf1LP9rQ58b5TU9mJL"}
}' http://127.0.0.1:9650/ext/bc/P | python3 -m json.tool
```

Measured 2026-07-28: exactly one entry, `NodeID-BoRS383b4Z9ZdsJSVUcnrXNCXh5Qj93ux`,
weight 100.

**What this costs you.** There is no fault tolerance whatsoever. An L1 needs 80%
of its stake connected to finalise; with one validator, losing it means 0%. That
is not hypothetical — it is exactly how the chain went down for fourteen hours on
2026-07-28 (`docs/incident-2026-07-28.md`), and no amount of restarting helped,
because nothing was wrong with the nodes.

Registering nodes 2 and 3 as validators is the single most valuable reliability
change available. They already exist, already run, and already track the chain;
they are simply not in the validator set. See `docs/validator-manual.md`.

The VM remains a single point of failure regardless — all three nodes share one
host. Geographic redundancy is separate, later work.

### The fee balance is a deadline

Each L1 validator pays a continuous fee from a balance held on the P-Chain, and at
zero it is **deactivated** — which is what caused the outage. Watch it:

```bash
avalanche validator getBalance --fuji \
  --validation-id 2rrjPnaiB3PnatWdkZH37yJqFHBePUupuC5cFPsLXXZja6EBrh
```

Top up with `avalanche validator increaseBalance --fuji --key csb-deployer
--validation-id <id> --balance <AVAX>`, funded from `csb-deployer`'s P-Chain
address (`P-fuji1mwwasu75mmwehls89rych7mxrnu0936lc8fpwv`).

Observed drain: topped up to 1.0 AVAX on 2026-07-28 and reading 0.983 a few hours
later. That is on the order of **weeks, not months**, so this needs a calendar
reminder, not good intentions. Take two readings a day apart to get a real rate
before deciding the interval.

### Historical note

Earlier single- and two-validator deployments of this chain repeatedly stopped
producing blocks, and this file previously attributed the current chain's
stability to having three validators. That explanation cannot be right, since the
current chain has one. The stalls are more plausibly the same fee-balance
exhaustion documented in the incident write-up. Recorded here because a wrong
explanation that predicts correctly is worse than no explanation.
