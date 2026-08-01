# Real egress: CSB → Fuji C-Chain via Avalanche ICTT

How to bridge KHRt from the CSB L1 to Avalanche's Fuji testnet C-Chain, replacing
the `MockBridgeAdapter` used in development.

This is the procedure as actually performed, in the order that works. Several
steps fail in ways that point at the wrong thing; those are called out where they
occur rather than collected at the end, because the error you see does not
resemble the cause.

## Architecture

```
CSB L1                                        Fuji C-Chain
──────                                        ────────────
EgressGateway ── policy: allowlist/tiers/caps/pause
   │
ICTTBridgeAdapter ── route table (council-owned)
   │ forceApprove + send()
ERC20TokenHome(KHRt) ══ ICM (Teleporter) ══▶ ERC20TokenRemote ("bridged KHRt")
        ▲                                          relayer delivers
   locks collateral
```

Policy lives in the gateway (ours); transport is audited ICTT + ICM
infrastructure (Ava Labs); the relayer is operated by the state.

## Before you start

Three addresses need access on CSB. All of them fail confusingly without it,
because Subnet-EVM refuses transactions from non-allow-listed addresses at
execution time — which surfaces as a revert, not as a permission error.

```bash
source ops/csb-env.sh

# deploys the ICTT Home on CSB
CSB_DEV_ADDR=<your deploy key address> CSB_DEV_GAS=2000 \
  npx hardhat run scripts/allow-dev.js --network csbRemote

# the relayer sends transactions on CSB to deliver messages
CSB_DEV_ADDR=<relayer address> CSB_DEV_GAS=2000 CSB_DEV_DEPLOYER=0 \
  npx hardhat run scripts/allow-dev.js --network csbRemote

# the deterministic ICM deployer (see step 1)
CSB_DEV_ADDR=0x618FEdD9A45a8C456812ecAAE70C671c6249DfaC CSB_DEV_GAS=100 \
  npx hardhat run scripts/allow-dev.js --network csbRemote
```

The relayer also needs **Fuji AVAX** on the C-Chain side — it pays gas in both
directions:

```bash
avalanche key transfer --fuji --key ewoq --destination-key cli-awm-relayer \
  --c-chain-sender --c-chain-receiver --amount 0.3
```

> **Do not run `avalanche blockchain describe csb` casually.** It prints private
> keys in plain text, including the deployer's. Filter it:
> `avalanche blockchain describe csb | grep -v -iE 'private|[0-9a-f]{64}'`

## Step 1 — Deploy ICM on CSB

ICTT rides on ICM (Teleporter). `ERC20TokenHome`'s constructor requires
`registry.latestVersion() > 0`, so with no ICM registry deployed the deploy fails
with a bare `execution reverted` that says nothing about registries.

> The getter is **`latestVersion()`** — a public state variable on
> `TeleporterRegistry` (`contracts/teleporter/registry/TeleporterRegistry.sol:51`),
> not `getLatestVersion()`, which this document previously claimed and which does
> not exist. Probing a registry with the wrong name reverts with no data, which is
> indistinguishable from "this address is not a registry" — so the wrong name turns
> a healthy contract into a confident false accusation.

**The fee-floor collision.** ICM deploys via a *pre-signed* transaction — that is
how the messenger lands on the same address on every chain. Its gas price is
baked into the signature at **2500 gwei** and cannot be changed, because changing
it changes the signature and therefore the deployer address. CSB's `minBaseFee`
is **47,619 gwei** (this is what prices a payment at about 1 riel). The
transaction is therefore permanently unmineable:

```
transaction underpriced: address 0x618FEdD9A45a8C456812ecAAE70C671c6249DfaC
have gas fee cap (2500000000000) < pool minimum fee cap (47619047619047)
```

Any chain with a fee floor above 2500 gwei must lower it temporarily:

```bash
source ops/csb-env.sh
CSB_GAS_TRIEL=0.05 npx hardhat run scripts/set-gas-price.js --network csbRemote
```

That sets the floor to ~2381 gwei. Raising a floor takes effect immediately;
*lowering* one only moves the minimum, and the live base fee decays a few percent
per block — and Subnet-EVM builds no blocks when idle. If the current base fee is
above the new floor, drive it down (the target must be at or above the new floor,
or it can never be reached):

```bash
CSB_TARGET_GWEI=2400 npx hardhat run scripts/settle-base-fee.js --network csbRemote
```

Then deploy: `avalanche icm deploy` → **Fuji Testnet** → blockchain **csb**.

**Restore the fee policy immediately afterwards:**

```bash
CSB_GAS_TRIEL=1 npx hardhat run scripts/set-gas-price.js --network csbRemote
```

Between those two commands gas is ~20× cheaper for everyone on the chain. On a
testnet that is acceptable for a few minutes; on anything real it is an announced
maintenance window.

**Finding the registry afterwards.** `avalanche blockchain describe csb` shows an
ICM table, but the addresses in it are **Fuji C-Chain's**, not CSB's. Checking
those against CSB reports `code: NONE` for a registry that deployed perfectly
well somewhere else. The authoritative source is the relayer config generated in
step 3 (`teleporter-registry-address` under CSB's `source-blockchains` entry), or
simply the fact that step 2 stops reverting.

## Step 2 — Deploy the ICTT pair

```bash
avalanche interchain tokenTransferrer deploy
```

- Network: **Fuji Testnet**
- Home blockchain: **csb**
- Home RPC: the default
- Token: **"Deploy a new Home for the token"** → **"An ERC-20 token"** → the
  **KHRt address**

That middle choice is the one to get right. **"A token that already has a Home
deployed (recommended)"** asks for the address of an existing `ERC20TokenHome`,
not the token — answering it with the ERC-20 calls TokenHome methods on a plain
token and fails as `execution reverted`, with nothing to indicate which prompt
was wrong.

- Home key: a key with contract-deploy rights and tRIEL
- Remote: **C-Chain**, RPC `https://api.avax-test.network/ext/bc/C/rpc`
- Remote key: any key with Fuji AVAX

**Write down both addresses it prints.** The deploy will then almost certainly
end with:

```
Error: timeout waiting for remote endpoint registration
```

That is expected and not a failure of the deployment. `registerWithHome()` sends
an ICM message from Fuji back to CSB, and no relayer is running yet. Both
contracts exist and are fine; they just do not know about each other.

## Step 3 — Run the relayer

```bash
avalanche interchain relayer deploy
```

- Network: **Fuji Testnet**
- **"Yes, I want to configure source and destination blockchains"** — deferring
  this produces a relayer that starts and relays nothing
- Add **both** `csb` and **C-Chain**, each as source *and* destination. The
  registration message needs C-Chain → csb; transfers need csb → C-Chain
- Relayer key: `cli-awm-relayer`

The CLI may report `timeout waiting for relayer initialization` while the relayer
is in fact running fine — that is the CLI's own health check, not the relayer.
Check before acting on it:

```bash
ps aux | grep -i icm-relayer | grep -v grep
ss -ltnp | grep 9095
```

**Only one relayer can run at a time.** A second instance dies on
`listen tcp :9095: bind: address already in use`, which the CLI reports as
`relayer process failed during setup` — a message that invites you to go looking
for a configuration problem that is not there.

To see what a relayer is actually doing, raise its log level. It ships at
`error`, which hides everything useful:

```bash
avalanche interchain relayer stop
# edit "log-level" to "debug" in
#   /root/.avalanche-cli/runs/Fuji/local-relayer/icm-relayer-config.json
avalanche interchain relayer start
avalanche interchain relayer logs
```

## Step 4 — Register the remote

If step 2 ended in the registration timeout, do not re-run the deploy — it
deploys a *second* remote and orphans the first. Register the existing one:

```bash
CSB_TOKEN_REMOTE=<ERC20TokenRemote on Fuji> \
CSB_REMOTE_KEY_NAME=csb-deployer \
  node scripts/register-remote.js
```

`registerWithHome()` is permissionless, so any key with Fuji AVAX works. Do not
use the relayer's key while the relayer is running — you would collide on its
nonce. Note that `ewoq` is built into avalanche-cli and has no `.pk` file; pick a
key that does (`ls ~/.avalanche-cli/key/`).

Confirm the message was delivered by looking for `RemoteRegistered` on the Home:

```bash
source ops/csb-env.sh
node -e "
const {ethers}=require('ethers');
(async()=>{const p=new ethers.JsonRpcProvider(process.env.CSB_RPC_URL);
const logs=await p.getLogs({address:'<TokenHome>',fromBlock:0,toBlock:'latest'});
for(const l of logs) console.log('block',l.blockNumber,l.topics[0].slice(0,20));})()"
```

- `0x8be0079c5316591413` — `OwnershipTransferred`, emitted twice by the
  constructor. Two of these alone means **not registered**.
- `0xf229b02a51a4c8d5ef` — `RemoteRegistered`. This is the one that matters.

## Step 5 — Wire it into CSB's egress policy

The destination blockchain ID must be 32-byte hex. Read it from the Warp
precompile rather than copying it from a document:

```bash
curl -s -X POST -H 'content-type:application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"0x0200000000000000000000000000000000000005","data":"0x4213cf78"},"latest"]}' \
  https://api.avax-test.network/ext/bc/C/rpc
```

```bash
source ops/csb-env.sh
CSB_TOKEN_HOME=<Home on CSB> \
CSB_TOKEN_REMOTE=<Remote on Fuji> \
CSB_DEST_BLOCKCHAIN_ID=0x… \
  npx hardhat run scripts/wire-ictt.js --network csbRemote
```

This deploys `ICTTBridgeAdapter`, sets the route, marks the adapter **and** the
TokenHome as KHRt system contracts, and repoints the gateway's KHRt policy at the
real adapter.

The system-contract marking is not optional. Both are contracts, so neither can
hold a KYC attestation, and KHRt enforces compliance on every transfer — without
it the first transfer into the Home reverts.

**Until this step runs, the gateway still points at `MockBridgeAdapter`,** which
accepts the tokens, emits `BridgeSend`, and stops. An egress request against it
looks entirely successful — `Transfer` and `EgressInitiated` both fire, the
sender's balance drops — and nothing reaches Fuji. Check which adapter is live:

```bash
node -e "
const {ethers}=require('ethers');const d=require('./app/deployments.json');
(async()=>{const p=new ethers.JsonRpcProvider(process.env.CSB_RPC_URL);
const g=new ethers.Contract(d.contracts.EgressGateway,
  ['function policies(address) view returns (bool,uint8,uint256,address)'],p);
console.log(await g.policies(d.contracts.KHRStablecoin));})()"
```

(The getter is `policies`, from `mapping(address => TokenPolicy) public policies`
— not `tokenPolicy`.) Tokens stranded in the mock come back with:

```bash
CSB_RELEASE_TO=<a KYC-active address> \
  npx hardhat run scripts/mock-release.js --network csbRemote
```

## Step 6 — Test

```bash
CSB_EGRESS_FROM=sokha CSB_EGRESS_AMOUNT=100 \
CSB_EGRESS_RECIPIENT=<address on Fuji> \
  npx hardhat run scripts/test-egress.js --network csbRemote
```

This refuses to send if the gateway is still on the mock, and checks policy, KYC
tier, freeze state, balance and gas before sending. Then check the Fuji side:

```bash
curl -s -X POST -H 'content-type:application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_call","params":[{"to":"<Remote>","data":"0x70a08231000000000000000000000000<recipient without 0x>"},"latest"]}' \
  https://api.avax-test.network/ext/bc/C/rpc
```

`0x2710` = 10000 = 100.00 KHRt at 2 decimals. It is also visible in any public
explorer — `https://testnet.snowtrace.io/token/<Remote>` — which is the point:
this is the boundary where sovereign-private becomes world-public.

Then repeat from the website, with a **different amount** so the two transfers
are distinguishable. The website exercises MetaMask signing, browser gas
estimation and the destination selector, none of which the script touches.

Finally, test the controls, which is the part worth showing people:

- a tier-1 account → `TierTooLow`
- a non-KYC'd account → `NotKycActive`
- over the daily cap → `DailyCapExceeded`
- `gateway.pause()` → all egress halts

## Step 7 — Bridge back: Fuji → CSB

```bash
source ops/csb-env.sh
CSB_TOKEN_REMOTE=<Remote on Fuji> \
CSB_TOKEN_HOME=<Home on CSB> \
CSB_HOME_BLOCKCHAIN_ID=0x9633e7227257f4de7dcd8e595bfafdd8cf6f88918926dd1d4e2ddfff46978a61 \
CSB_BACK_TO=<recipient on CSB, must be KYC-active> \
CSB_BACK_AMOUNT=50 \
  node scripts/bridge-back.js
```

The token on Fuji is **not** KHRt — it is `ERC20TokenRemote`, a separate ERC-20
minted when collateral was locked on CSB. `send()` burns the caller's balance of
it and emits an ICM message; when the relayer delivers that message, the
TokenHome releases the equivalent KHRt on CSB. No `approve()` is needed, because
the remote burns its own token rather than pulling one.

**The recipient on CSB must be KYC-active.** KHRt enforces compliance on every
transfer, and the TokenHome releasing collateral is a transfer like any other. If
the recipient is not verified, the **Fuji burn succeeds and the CSB delivery
reverts** — the tokens are recoverable (the collateral stays in the Home and the
message can be re-delivered once the recipient is verified) but the failure lands
on a different chain from the transaction that caused it. `scripts/bridge-back.js`
reads CSB's identity registry before burning anything and refuses if the
recipient cannot receive.

That asymmetry is deliberate and is the point of the design: leaving the
sovereign perimeter is council-governed and publicly visible; coming back is
subject to the same KYC rule as any domestic transfer. The bridge cannot be used
to launder an identity.

Note also that the remote's `decimals()` need not match KHRt's 2 — ICTT can be
configured with a different scale on the remote side. The script reads it rather
than assuming, since guessing wrong sends 100× or 1/100th of the intended amount.

## Notes

- **The boundary, made visible:** the recipient balance on Fuji is visible in any
  public explorer — this is where sovereign-private becomes world-public, by
  council-governed exception only.
- **Collateral.** `RemoteRegistered` carries `initialCollateralNeeded`. If it is
  non-zero, the first send goes toward collateral rather than to the recipient —
  a CSB-side success with a zero Fuji balance is more likely this than a relayer
  fault.
- **Ingress is ungated in v1** (see step 7). There is no `IngressGateway` mirror
  of the egress policy: no tier requirement, no daily cap, no pause. The only
  control on the way back in is KHRt's own KYC rule, which is enough to keep
  funds inside the verified perimeter but does not let the council rate-limit or
  halt inbound flow the way it can outbound. An `IngressGateway` escrow is future
  work.
- **Fees.** ICTT primary/secondary fees are zero — a state-run relayer needs no
  incentive. That is the bridge's own fee and is separate from CSB gas; the
  transaction still costs about 1 riel like any other.
- **Relayer gas config.** The generated config sets
  `max-priority-fee-per-gas: 2500000000` (2.5 gwei) and `max-base-fee: 0` for
  CSB. If the relayer stops getting transactions mined after the fee floor is
  restored to 47,619 gwei, `max-base-fee` in that config is the knob.
- The `SendTokensInput` struct in
  `contracts/egress/interfaces/IERC20TokenTransferrer.sol` mirrors
  `icm-contracts`; re-verify the layout against the pinned release before
  production.

## Recorded values from the first working deployment

Blockchain IDs, CB58 and hex (hex is what `setRoute` wants):

| Chain | CB58 | hex |
|---|---|---|
| Fuji C-Chain | `yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp` | `0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5` |
| CSB | `299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW` | `0x9633e7227257f4de7dcd8e595bfafdd8cf6f88918926dd1d4e2ddfff46978a61` |

Contracts (this deployment only — they change if the chain is rebuilt):

| What | Address |
|---|---|
| `ERC20TokenHome` (CSB) | `0x0f2E03fFcb14874413a2dd0F132a248eb3b9E6E1` |
| `ERC20TokenRemote` (Fuji C-Chain) | `0xB0a67c27B31ed58a28dBce75aD8E441216257594` |
| ICM registry (CSB) | `0x22C75bE6Cbe94050c16D5944a08144a81a54ED35` |
| ICM messenger (both chains) | `0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf` |
| ICM deterministic deployer | `0x618FEdD9A45a8C456812ecAAE70C671c6249DfaC` |
