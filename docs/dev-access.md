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
the "private to the world" boundary). The gated app proxy (`/rpc`) is
passcode+cookie protected and can't be used by MetaMask directly. Two ways to
give a developer RPC access:

### Option A — SSH tunnel (recommended, keeps RPC private)

The developer forwards the port over SSH and points MetaMask at their own
localhost:

```bash
# on the developer's machine
ssh -L 9650:127.0.0.1:9650 root@cicd-upecy-u70984.vm.elestio.app -N
```

Their MetaMask RPC URL is then
`http://127.0.0.1:9650/ext/bc/mHu6H4FQ3K6fCmmHsingG2t8y5wiVvvrEZXpS25ZhodU8gdz3/rpc`.
Nothing is exposed publicly; access is controlled by who has SSH.

### Option B — dedicated public dev RPC (only for a controlled pilot)

If you must hand out a URL, put a reverse-proxy route in front of the RPC on a
**hard-to-guess path** and treat it as semi-public — the allowlists still stop
anyone unapproved from transacting, but anyone with the URL can *read* all chain
data. Do **not** expose port 9650 directly; proxy it (see `docs/ssl.md`) at e.g.
`https://cicd-upecy-u70984.vm.elestio.app/dev-rpc/…`. Prefer Option A unless a browser
dapp needs it.

## 3. Add the network to MetaMask

MetaMask → Networks → **Add network manually**:

| Field | Value |
|---|---|
| Network name | `CSB Testnet` |
| New RPC URL | `http://127.0.0.1:9650/ext/bc/mHu6H4FQ3K6fCmmHsingG2t8y5wiVvvrEZXpS25ZhodU8gdz3/rpc` (via the tunnel), or your dev-RPC URL |
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
