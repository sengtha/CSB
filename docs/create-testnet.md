# Creating the CSB testnet on Fuji (coordinator guide)

The validator manual tells operators to get `CSB_SUBNET_ID`, `CSB_VM_ID`, and the Blockchain ID "from the coordinator". **This document is for the coordinator — the person who creates the chain and thereby mints those IDs.** Run it once, on your VM (Elestio or other, with `infra/setup-vm.sh` already run so `avalanche-cli` is installed).

## Order of operations (do not skip ahead)

```
0. bash infra/setup-vm.sh                      → installs avalanche-cli
1. avalanche key create csb-deployer           → your key (0 AVAX at first)
2. faucet → C-Chain 0x address, then
   avalanche key transfer                      → ~3 AVAX onto the P-Chain
3. edit genesis (0xC0DE… → your 0x address), then
   avalanche blockchain create csb …           → mints the VM ID
4. avalanche blockchain deploy csb --fuji      → mints Subnet ID + Blockchain ID
5. avalanche blockchain describe csb           → READ the three IDs
6. fill .env with those IDs                    → only NOW build the validator:
   docker compose -f docker-compose.validator.yml up -d --build
```

Running the validator compose before step 5 fails on purpose: it refuses to start without a real `CSB_SUBNET_ID`, because no such ID exists until step 4 creates it. Nothing is wrong with your setup when you see that error — you're just at an earlier step.

Quick orientation on the three values:

| Value | What it is | Where it comes from |
|---|---|---|
| `AVAGO_NETWORK_ID` | Which Avalanche network anchors the L1 | Nothing to fetch — it's just the word **`fuji`** for testnet, `mainnet` later |
| `CSB_SUBNET_ID` | The identifier of your L1's subnet on Avalanche | **Created** by step 4 below; read it in step 5 |
| `CSB_VM_ID` | The identifier of your chain's VM (plugin filename) | **Created** by step 3 below; read it in step 5 |

## 1. Create the deployer key

```bash
avalanche key create csb-deployer
avalanche key list --fuji --keys csb-deployer
```

`key list` shows the key's addresses: a **C-Chain/EVM address** (`0x…`) and a **P-Chain address** (`P-fuji…`). This one key will pay the Fuji fees, own the genesis precompile admin rights, and deploy the contracts during the testnet phase. Back up `~/.avalanche-cli/key/csb-deployer.pk` — testnet-grade custody is fine, but don't lose it.

## 2. Get test AVAX

- Faucet: <https://core.app/tools/testnet-faucet/> → request AVAX to your **C-Chain (0x…) address**. If the faucet asks for a coupon code, current codes are published on Avalanche's Builder Hub / Academy pages, or ask in the Avalanche Discord.
- The L1 creation transactions happen on the **P-Chain**, so move funds across:

```bash
avalanche key transfer   # interactive: from csb-deployer C-Chain -> csb-deployer P-Chain, ~3 AVAX
```

2–3 AVAX is plenty for creation plus months of the continuous validator fee (~1.33 AVAX/month/validator, paid from the P-Chain balance).

## 3. Put your address into the genesis, then create the blockchain

Edit `chain/genesis.example.json`: replace every `0xC0DE…` placeholder (the four precompile `adminAddresses` and the `alloc` key) with your deployer's **0x address** (for `alloc`, drop the `0x` prefix, matching the existing format). Then:

```bash
avalanche blockchain create csb --genesis chain/genesis.example.json --evm --proof-of-authority
```

When prompted for the **validator manager owner**, use the deployer key. This step mints the **VM ID**.

## 4. Deploy to Fuji

```bash
avalanche blockchain deploy csb --fuji
```

Prompts vary a little between CLI versions; the choices that matter:

- **Pay with:** `csb-deployer` (stored key).
- **Bootstrap validators:** the chain needs at least one validator at birth. The easiest path is letting the CLI **use the local machine as a bootstrap validator** (it runs an avalanchego node on this VM) — accept that option if offered. Alternatively, start your own validator container first (`docker-compose.validator.yml` — it can run before registration) and supply its NodeID + BLS proof when the CLI asks.

This step mints the **Subnet ID** and **Blockchain ID** and registers the bootstrap validator(s).

## 5. Read back the three IDs

```bash
avalanche blockchain describe csb
```

Record from the output: **Subnet ID** (`CSB_SUBNET_ID`), **VM ID** (`CSB_VM_ID`), **Blockchain ID** (part of the RPC URL and used in `isBootstrapped` checks). Put them in:

- your own `.env` (validator + app stacks on this VM),
- the project record (`docs/checklists.md` → "Create the chain" items),
- the blanks in `docs/validator-manual.md` before sending it to other operators.

## 6. Continue with the existing guides

- Your own validator: `docker-compose.validator.yml` with the new `.env` (see `docs/elestio.md` §A).
- Contracts + app: `docker-compose.app.yml` — the deployer key from step 1 is the txAllowList admin the deploy profile needs (`docs/docker.md`).
- Other validator operators: send them `docs/validator-manual.md` with the IDs filled in; register each NodeID they send back:

```bash
avalanche blockchain addValidator csb --fuji   # prompts for NodeID + BLS proof
```

## If something doesn't match

`avalanche-cli` prompts and flags shift between releases. If a step's output doesn't look like this guide, run the command with `--help`, or paste the actual output into an issue/discussion — the sequence (key → fund → create → deploy → describe) is stable even when the wording isn't.
