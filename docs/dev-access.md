# Developer access to CSB (deploy contracts + MetaMask)

CSB is a **permissioned** chain, so a developer needs to be *enabled* before they
can transact or deploy — unlike a public testnet where any address just works.
Three things, all granted by the deployer/admin with one script, then MetaMask
is a normal network config on top.

## 1. Enable the developer (admin does this once)

An operator with the deployer key runs, on the VM:

```bash
export PATH=$PATH:$HOME/bin
export RPC=http://127.0.0.1:9650/ext/bc/mHu6H4FQ3K6fCmmHsingG2t8y5wiVvvrEZXpS25ZhodU8gdz3/rpc

CSB_RPC_URL=$RPC CSB_CHAIN_ID=8555 CSB_DEPLOYER_KEY=<deployer-key> \
CSB_DEV_ADDR=0xDEVADDRESS \
  npx hardhat run scripts/allow-dev.js --network csbRemote
```

That enables the address on both allowlist precompiles and funds it with gas:

| Grant | Precompile | Why |
|---|---|---|
| Transaction access | `txAllowList` `0x…02` | Send *any* tx at all |
| Contract deploy | `contractDeployerAllowList` `0x…00` | Deploy contracts (omit with `CSB_DEV_DEPLOYER=0`) |
| Native gas (tRIEL) | Native Minter / transfer | Pay for transactions |

To enable several at once: `CSB_DEV_ADDR=0xdev1,0xdev2`. Change the gas grant with
`CSB_DEV_GAS=25`.

> This is **technical** access only. To *hold or transfer KHRt*, the address also
> needs a KYC attestation in the IdentityRegistry (admin console → Identity).

## 2. Reach the RPC from the developer's machine

The node's RPC listens on `127.0.0.1:9650` on the VM and is **not** public (that's
the "private to the world" boundary). The node's raw port must never face the
internet. Two ways to give a user RPC access from their own wallet:

### Option A — Scoped RPC token (recommended: no tunnel, read-filtered) ⭐

The app server exposes a per-user endpoint `https://<host>/rpc/<token>` that maps
the token to one KYC'd address and returns a **read-filtered** view: the user
sees only their own balances, their own transaction history, and chain/fee data —
never other users' activity — and can submit their own signed transactions.
Bulk reads (logs/blocks/txs) are filtered to the caller; balance/KYC lookups of
other addresses are refused; `admin`/`debug`/`platform` namespaces are blocked
(see `app/rpc-filter.js`). The raw node stays private; the app is the only door.

Issue a token for an (already KYC-enabled) address:

```bash
node scripts/make-rpc-token.js 0xUSERADDRESS "Sokha"
# prints a URL like https://<your-elestio-host>/rpc/<token>
```

The user puts that URL in MetaMask (§3). Requires the app to be served over your
HTTPS proxy (`docs/ssl.md`). This is the "public within the country" door: no SSH,
but each holder sees only what they're entitled to.

> Honest scope: this is practical scoping (no casual or bulk access to others'
> data), not cryptographic confidentiality — see the header of `app/rpc-filter.js`.
> The URL token is a bearer secret: give it only to that user; if it leaks, the
> holder can read that one user's scoped data (never anyone else's), so rotate it
> by re-running the script and removing the old entry from `app/rpc-tokens.json`.

### Option B — SSH tunnel (for a trusted operator/developer who needs raw RPC)

A developer who needs the *unfiltered* node (e.g. to run an indexer or debug)
forwards the port over SSH and points tools at their own localhost:

```bash
# on the developer's machine
ssh -L 9650:127.0.0.1:9650 root@cicd-upecy-u70984.vm.elestio.app -N
```

Their RPC URL is then
`http://127.0.0.1:9650/ext/bc/mHu6H4FQ3K6fCmmHsingG2t8y5wiVvvrEZXpS25ZhodU8gdz3/rpc`
(full, unfiltered). Nothing is exposed publicly; access is controlled by who has
SSH. Use this only for trusted operators — it is the whole ledger.

## 3. Add the network to MetaMask

MetaMask → Networks → **Add network manually**:

| Field | Value |
|---|---|
| Network name | `CSB Testnet` |
| New RPC URL | **Scoped (recommended):** `https://<your-elestio-host>/rpc/<token>` from `make-rpc-token.js`. **Or raw via tunnel:** `http://127.0.0.1:9650/ext/bc/mHu6H4FQ3K6fCmmHsingG2t8y5wiVvvrEZXpS25ZhodU8gdz3/rpc` |
| Chain ID | `8555` |
| Currency symbol | `tRIEL` |
| Block explorer | *(leave blank — the app's gated `explorer.html` is not an Etherscan-style API)* |

> The blockchain ID in the RPC URL (`mHu6H4FQ…`) is specific to this deployment.
> If the chain is ever redeployed it changes — read the current one from
> `docs/deployment-status.md` or `avalanche blockchain describe csb`. The port is
> **9650** (the bootstrap node); `9651` is P2P.

Then import the enabled account: MetaMask → account menu → **Import account** →
paste its private key. To see KHRt, **Import tokens** with the KHRStablecoin
address from `docs/deployment-status.md` (2 decimals).

## 4. Deploy a contract

**Hardhat** — point it at CSB with the enabled dev key:

```bash
CSB_RPC_URL=$RPC CSB_CHAIN_ID=8555 CSB_DEPLOYER_KEY=<dev-key> \
  npx hardhat run scripts/your-deploy.js --network csbRemote
```

**Remix** — set the environment to *Injected Provider – MetaMask* with the CSB
network selected, and deploy as usual; MetaMask signs with the enabled account.

If a deploy reverts with a `SenderAddressNotAllowListed`-style error, the address
isn't enabled on `contractDeployerAllowList` — re-run step 1 (ensure
`CSB_DEV_DEPLOYER` is not `0`). If a plain transfer fails with insufficient
funds, it needs gas — step 1 funds it, or use `scripts/fund-native.js`.
