# Multisig on CSB

`docs/architecture.md` §4 lists seven powers split across institutions, and then
admits that on this deployment **every one of them is held by the same deployer
key** — a key whose private half was printed in plain text by `avalanche
blockchain describe`. The separation of powers is real in the contracts and worth
nothing in practice. This document is how that stops being true.

## Status

The contracts and scripts exist and are verified. **Nothing is deployed on 8555
yet**; when it is, `docs/architecture.md` §4's status box must change with it.

Verified on a local chain, end to end:

- a 2-of-3 Safe deployed, with owners and threshold read back from the wallet
  rather than assumed from the arguments sent to it;
- signatures collected in arbitrary order, reordered, and executed;
- a signature from a non-owner rejected, and the same owner signing twice
  rejected;
- the wallet granted `ISSUER_ROLE` on `IdentityRegistry` and used to **issue a
  KYC attestation that no single key authorised**.

That last one is the whole point. Everything else is plumbing.

## What gets deployed

Safe **1.4.1**, unmodified, from `@safe-global/safe-contracts` (LGPL-3.0). Four
contracts plus one proxy per wallet:

| Contract | Why |
|---|---|
| `SafeL2` | the logic every wallet delegates to |
| `SafeProxyFactory` | creates wallets cheaply as proxies |
| `CompatibilityFallbackHandler` | EIP-1271 signatures, ERC-165/721/1155 receipt |
| `MultiSendCallOnly` | batching without `delegatecall` |

Two choices worth understanding before you run it, because both are expensive to
reverse.

**`SafeL2`, not `Safe`.** Identical except that `SafeL2` emits an event for every
execution. Subnet-EVM serves no Parity-style `trace_` RPCs, so if CSB ever gets a
Safe web UI, the Transaction Service can only index it in event mode — which
requires `SafeL2`. Getting this wrong means redeploying every wallet.

**The addresses are not Safe's canonical ones.** Safe's well-known addresses come
from Nick's method: a presigned transaction with a gas price hardcoded near 100
gwei. CSB runs around 55,000 gwei, because tRIEL is 18-decimal and a transfer is
priced at about one riel, so that transaction underpays by roughly 500× and can
never be included. It could be forced by dropping the base fee through
`feeManager` for the duration — but a matching address is only worth something to
cross-chain tooling CSB does not use. So they are deployed normally and recorded
in `deployments.json`.

## Before you start: the owners

A multisig is only as real as the independence of its keys. Three things have to
be true, and none of them are technical:

1. **Different people hold them.** Three keys in one operator's password manager
   is a 1-of-1 wearing a costume.
2. **Different machines.** A shared laptop is a shared key.
3. **The threshold survives one loss.** 2-of-3 tolerates one unavailable or
   compromised owner. 2-of-2 tolerates nothing — lose one key and the wallet is
   sealed forever, with whatever roles it held.

Generate each key on the machine it will live on. Do **not** use
`avalanche key create` — those land in `~/.avalanche-cli/key/`, which
`avalanche blockchain describe` prints in plain text, which is exactly how the
deployer key was burned.

Every owner must be on `txAllowList` first. The Safe is a contract and never
originates a transaction; an owner does, calling `execTransaction`. An owner who
is not listed holds a signing key that cannot be used, and the failure arrives as
a bare `execution reverted` from the precompile with nothing naming the cause.
`deploy-safe.js` refuses to run until every owner passes this check.

## Deploying

```bash
(cd vendor/safe && npm install)          # once — see the note at the end
source ops/csb-env.sh

CSB_SAFE_OWNERS=0xAAA...,0xBBB...,0xCCC... \
CSB_SAFE_THRESHOLD=2 \
  npx hardhat run scripts/deploy-safe.js --network csbRemote
```

It refuses duplicate owners and out-of-range thresholds, warns loudly if you ask
for anything that is not really a multisig, and records a `placeholder: true`
flag in `deployments.json` when you do, so a 1-of-1 cannot later be mistaken for
the thing this document describes.

### The wallet is attested, not made a system contract

`KHRStablecoin._update` calls `_requireEligible` on both sides:

```solidity
if (!isSystemContract[account] && !identity.isActive(account)) revert NotKycActive(account);
```

So an unattested Safe **cannot receive a single riel** — a council wallet unable
to hold the currency it governs. Two ways to satisfy that check, and they are not
equivalent:

- `identity.register(safe, …)` — attested like any other holder. The tier
  transfer cap and the public-good levy still apply.
- `setSystemContract(safe, true)` — also works, and silently exempts the wallet
  from **both**. Right for a bridge or the converter. Wrong for a governance
  wallet, which should be at least as constrained as the people it governs.

The script does the first and says so. If you find yourself reaching for the
second, that is a decision to write down, not a workaround.

## Using it

There is no web UI — Safe's app has no entry for chain 8555, and the Transaction
Service is a Postgres, RabbitMQ and indexer deployment for one wallet. Signatures
are collected by hand, which sounds worse than it is: **the owners never have to
meet, and no key ever leaves its machine.**

```bash
# 1. Anyone runs this. It signs nothing and prints what needs authorising.
npx hardhat run scripts/safe-exec.js --network csbRemote

# 2. Each owner signs the printed EIP-712 payload wherever their key lives,
#    and sends back 65 bytes.

# 3. Anyone submits — the submitter pays gas and need not be an owner.
CSB_SAFE_SIGNATURES=0xsig1,0xsig2 \
  npx hardhat run scripts/safe-exec.js --network csbRemote
```

The default transaction is the Safe calling itself with no value and no data — a
rehearsal that exercises hashing, signing, ordering and execution with no way to
lose anything if some part of it is wrong. Do that first.

Signatures may be returned in any order; the script sorts them, because Safe
requires ascending owner order and rejects the whole batch otherwise with an
error that names neither the offending signature nor the rule. It also checks its
own EIP-712 hash against the contract's `getTransactionHash` before printing
anything, so nobody is sent off to sign a hash the chain will not accept.

`CSB_SAFE_OWNER_KEYS` will sign locally with keys in one environment variable.
It exists to rehearse with and it reproduces exactly the single point of failure
the multisig removes. The script says so every time it is used.

**A green receipt is not success.** Safe reports a failed inner call by emitting
`ExecutionFailure` rather than reverting. The script checks for it, and tells you
the nonce advanced anyway — so a failed transaction has to be re-signed, not
retried.

## Wallets people ask for, through the site

`safe.html` lets anyone name owners and a threshold and request a wallet;
`admin.html` shows the queue and creates it. It is the KYC flow's shape exactly,
and for the same reason — **the server never holds a key**.

### Why it is a queue and not a button

Subnet-EVM checks **`tx.origin`** against `contractDeployerAllowList` when a
contract is created, not the caller of `CREATE`. The Avalanche documentation says
this is deliberate, *"to provide a great UX with factory contracts"*. On CSB the
effect is the reverse: allow-listing `SafeProxyFactory` achieves nothing, and a
visitor pressing "create" in their own browser is refused by the precompile before
any contract runs. Contract creation here is restricted to vetted deployers, and a
Safe is a contract.

Three ways out were weighed:

| | Cost |
|---|---|
| Grant every requester deployer rights | They can then deploy **anything**. One of the five precompile controls becomes a formality. |
| Let the server relay the creation | The app server holds a private key. It holds none today — that is what `server-secrets.js` is for — and it is internet-facing behind one passcode. |
| **Queue it; an operator creates it** | Not instant. A human is in the loop. |

The third was chosen. Paying for the creation confers nothing: ownership is fixed
by the owner list passed to `setup()`, so the operator has no power over the
wallet afterwards. Requests are refused up front if any owner is missing from
`txAllowList`, since such an owner holds a key that could never sign.

### Where the wallet list comes from

Not from this server. Every Safe on CSB is a proxy created by one factory, so
`app/safes.js` reads `ProxyCreation` logs and asks each wallet directly for its
owners and threshold. A server-side registry of who owns what would be a second
answer to a question the chain already answers, and the two would disagree the
first time the server was restored from a backup.

Wallets created this way are **not** written to `deployments.json` — that file
records infrastructure. To operate one, pass its address:

```bash
CSB_SAFE=0x… npx hardhat run scripts/safe-exec.js --network csbRemote
```

## Moving a role to it

This is the part with no undo. The order matters more than the speed.

1. **Grant alongside, never instead.** `grantRole(ROLE, safe)` while the deployer
   keeps its own copy. Nothing is lost yet.
2. **Exercise it through the Safe.** Do the real thing the role is for, with real
   signatures from real owners on their own machines.
3. **Only then renounce the deployer's copy.** `renounceRole(ROLE, deployer)`.
4. **One role at a time.** A misconfiguration discovered on role two is a
   nuisance; discovered across all seven at once it is a rebuild.

**Leave the precompile admin until last, and think hard before doing it at all.**
The `txAllowList` admin decides who may send any transaction on CSB. A wallet
holding it that cannot reach its threshold — a lost key, an owner who leaves, a
threshold set higher than the number of reachable humans — means **nobody can
transact on CSB again, and there is no recovery path**. Precompile roles are not
`AccessControl`; there is no council override, no timelock, no escape hatch. The
same is true in weaker form for the Validator Manager owner.

Before that step, at minimum: confirm every owner can independently produce a
valid signature, and keep a second admin address that is not the Safe.

## Why `vendor/safe`

Safe 1.4.1 declares `peerDependencies: { ethers: "5.4.0" }` — an exact pin on a
major version this project left behind. Adding it to the root `package.json`
makes `npm install` fail for anyone who clones the repo. Installing it with
`--no-save` is worse, and was tried here first: npm treated the rest of the tree
as extraneous and **pruned hardhat-toolbox's dependencies**, leaving the repo
unable to load its own config.

`vendor/safe` has its own `package.json`, so npm resolves it as a separate tree
that never sees the root's ethers. The root install needs no flags and cannot be
damaged by it. Nothing of Safe's is copied into this repository — the artifacts
are LGPL-3.0 and stay in `node_modules`, exactly as the Aave and Uniswap
artifacts already do.

## What this does not solve

- **No UI.** `safe-cli` works against any RPC if a terminal is not acceptable.
- **No transaction service**, so no shared queue of pending transactions. Owners
  coordinate out of band. At council scale that is a group chat, not a problem.
- **It does not make the roles independent.** A Safe whose three owners all
  report to the same office is a procedural improvement and nothing more. The
  architecture's claim is about *institutions*, and no contract can check that.
