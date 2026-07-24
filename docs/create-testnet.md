# Creating the CSB testnet on Fuji (coordinator guide)

## Who needs this document — and who doesn't

There are two roles, with very different amounts of work:

| Role | What they run | Tools needed |
|---|---|---|
| **Validator operator** (joins an existing chain) | `docker-compose.validator.yml` with IDs received from the coordinator | **Docker only** — see [`validator-manual.md`](validator-manual.md) |
| **App operator** | `docker-compose.app.yml` against a running chain | **Docker only** |
| **Coordinator** (creates the chain — one person, once) | The steps in **this document**, then Docker like everyone else | avalanche-cli, a funded test key, ~1–2 hours including waiting |

If someone told you "just use Docker": that's true unless you are the coordinator. Creating a chain means submitting transactions to the Avalanche network — keys, test funds, and the `avalanche` CLI. It happens once; after it, everything is Docker.

## Order of operations (do not skip ahead)

```
0. bash infra/setup-vm.sh                      → installs avalanche-cli
1. avalanche key create csb-deployer           → your key (0 AVAX at first)
2. faucet → C-Chain 0x address, then
   avalanche key transfer                      → AVAX onto the P-Chain
3. avalanche blockchain create csb (wizard)    → mints the VM ID; answers below
4. avalanche blockchain deploy csb --fuji      → mints Subnet ID + Blockchain ID  (RUN IN TMUX)
5. avalanche blockchain describe csb           → READ the three IDs
6. fill .env with those IDs                    → only NOW build the validator:
   docker compose -f docker-compose.validator.yml up -d --build
```

Running the validator compose before step 5 fails **on purpose**: it refuses to start without a real `CSB_SUBNET_ID`, because no such ID exists until step 4 creates it. That error means you're at an earlier step, not that something is broken.

Also normal at this stage: your VM's `https://….elestio.app` URL times out in a browser. Nothing listens on the web ports until the app stack runs (near the end) — don't debug the browser.

## Field-tested realities (read before starting)

These are the things that actually bite, learned the hard way:

1. **Run long steps inside `tmux`.** The deploy step runs for a long time; if your SSH session drops, a bare command dies with it and must be re-run. `sudo apt-get install -y tmux`, then `tmux new -s csb`, work inside it. Reconnect later with `tmux attach -t csb`. Detach on purpose with `Ctrl+B`, then `D`.
2. **`avalanche: command not found` in a new session** — the CLI lives in `~/bin`, which fresh logins may not have on PATH:
   ```bash
   export PATH=$PATH:$HOME/bin
   echo 'export PATH=$PATH:$HOME/bin' >> ~/.profile
   ```
3. **`describe` prints your private keys.** The "Initial token allocation" table includes the deployer's private key in plain text. Never paste that table anywhere public (issues, chat, Discord); operators only ever need the Subnet ID / VM ID / Blockchain ID. A testnet key that leaks is testnet-only forever.
4. **Elestio SSH:** the root password is displayed in the service's dashboard (*Admin/SSH credentials*, reveal icon); the dashboard also has a browser terminal that needs no password. SSH works against the same hostname whose HTTPS times out — different ports.
5. **Use the wizard — do NOT pass a hand-written `--genesis`.** A custom genesis lacks the pre-deployed Validator Manager bytecode the CLI's V2 PoA flow expects at `0x0FEEDC0DE…`; the deploy then dies at "Initializing Proof of Authority Validator Manager" with *"no new block produced"* / *"no contract code at given address"* (proven by four failed attempts). The wizard genesis embeds the manager contracts, correct timestamps, and warp config — and its prompts can express every CSB precompile (answers in step 3). The only trap inside the wizard: never accept "defaults for a test environment" (it prefunds the public ewoq key, which Fuji rejects with *"can't airdrop to default address"*).
6. **The live network dictates your versions — check it, don't trust docs.** Fuji upgrades continuously; a node even one protocol version behind connects but never finishes bootstrapping ("context deadline exceeded", with peer log lines advising "you may want to update your client"). Before starting: update avalanche-cli to latest (re-run its install script), and verify the pin: the newest `subnet-evm` release's `compatibility.json` protocol number must appear in the target avalanchego's `version/compatibility.json`. Pin `--vm-version` and the Docker pair to that. As of this writing the ceiling is **AvalancheGo `v1.14.1` + Subnet-EVM `v0.8.0` (protocol 44)** — `v1.14.2`/`v1.15.0` bumped to protocol 45/46 with no matching Subnet-EVM release, so they are *not* usable for a Subnet-EVM L1 even though Fuji's primary network runs them. A protocol-44 L1 validator still peers with the newer primary network (with "you may want to update your client" warnings) and runs its own L1 consensus fine. Do not "upgrade" to `v1.15.0` chasing those warnings — you'll break the VM plugin.
7. **Warp needs a post-Durango activation time.** `warpConfig.blockTimestamp` must be a recent Unix timestamp (the repo genesis uses 1720000000), never `0` — otherwise the VM rejects the whole genesis with *"warp cannot be activated before Durango"* and the deploy hangs forever at "waiting to be bootstrapped" (the error is only visible in the node's main.log).
8. **Interrupted deploys are resumable.** Re-running `avalanche blockchain deploy csb --fuji` picks up what already completed on Fuji. Check `avalanche key list` afterwards — an interrupted attempt may have spent some P-Chain AVAX, so the retry can need a faucet top-up.

## 1. Create the deployer key

```bash
avalanche key create csb-deployer
avalanche key list --fuji --keys csb-deployer
```

`key list` shows the key's addresses: a **C-Chain/EVM address** (`0x…`) and a **P-Chain address** (`P-fuji…`). This one key will pay the Fuji fees, own the genesis precompile admin rights, and deploy the contracts during the testnet phase. Back up `~/.avalanche-cli/key/csb-deployer.pk` — testnet-grade custody is fine, but don't lose it.

## 2. Get test AVAX (C-Chain first, then move it to the P-Chain)

- Faucet: <https://core.app/tools/testnet-faucet/> → request AVAX to your **C-Chain (0x…) address**. If it asks for a coupon code, current codes are on Avalanche's Builder Hub / Academy pages or the Avalanche Discord. Aim for ~2 AVAX total (run it more than once if amounts are small).
- The faucet only fills the C-Chain; **chain creation happens on the P-Chain**, and the deploy fails with *"required balance … on PChain is 100000000 but the given key has 0"* if you skip this transfer:

```bash
avalanche key transfer
# answers: Fuji · from C-Chain · to P-Chain · key csb-deployer ·
#          destination = the same key's P-fuji… address · amount ~1.5 AVAX
avalanche key list --fuji --keys csb-deployer   # P-Chain row must now show a balance
```

The deploy locks ~0.1 AVAX as the bootstrap validator's continuous-fee balance (drained at ~1.33 AVAX/month) plus small transaction fees — top the P-Chain up periodically during the testnet.

## 3. Create the blockchain through the wizard (field-proven answer sheet)

```bash
avalanche blockchain create csb --force --evm --proof-of-authority --vm-version v0.8.0
```

(The pinned `--vm-version` must match the validator image's Subnet-EVM version — the CLI otherwise picks the newest, which may need a release-candidate AvalancheGo.)

Wizard answers, in the order the prompts appear — `<ADMIN>` is your deployer's 0x address:

| Prompt | Answer |
|---|---|
| ValidatorManager controller | Stored key → `csb-deployer` (the slot a Governing Council multisig takes in production) |
| Connect with other blockchains / C-Chain? | **Yes** — the egress gateway rides on ICM/ICTT |
| Use default values? | **"I don't want to use default values"** (never "test environment defaults" — ewoq trap) |
| Chain ID | `8555` |
| Token symbol | `tRIEL` |
| Initial token allocation | **Define a custom allocation** → `<ADMIN>` → e.g. `1000000` |
| Allow minting new native tokens? | **Yes** (Native Minter ON) → allow list: Add → **Admin** → `<ADMIN>` → Confirm |
| Fee configuration | **Low block size / Low throughput** (proven default; go zero-fee later via feeManager) |
| Dynamic fees? | **No, constant gas prices** (anti-spam lives in the identity layer) |
| Fees adjustable without upgrade? | **Yes** (Fee Manager ON) → Admin → `<ADMIN>` → Confirm |
| Anyone can issue txs & deploy contracts? | **No** |
| Anyone can issue transactions? | **No** (Transaction Allow List ON) → Admin → `<ADMIN>` → Confirm |
| Anyone can deploy contracts? | **No** (Deployer Allow List ON) → Admin → `<ADMIN>` → Confirm |

This expresses all four CSB precompiles inside the CLI's known-good genesis (pre-deployed Validator Manager, correct warp/timestamps). Fees start non-zero: after launch, the feeManager admin sets `minBaseFee` to 0 for the free-gas model — deliberately a runtime change, not a genesis experiment. `chain/genesis.example.json` remains in the repo as a **reference for what the resulting config should contain**, not as a deploy input.

Sanity-check before spending AVAX:

```bash
avalanche blockchain describe csb --genesis | grep -E 'chainId|minBaseFee|txAllowList'
# expect: "chainId": 8555 · "minBaseFee": 0 · a txAllowListConfig section
```

## 4. Deploy to Fuji — in tmux

Pin the AvalancheGo version explicitly. **The working pair is AvalancheGo
`v1.14.1` + Subnet-EVM `v0.8.0` — both RPCChainVM plugin protocol 44.** Do not
chase newer AvalancheGo: `v1.14.2` is protocol 45 and `v1.15.0` is protocol 46,
and **no Subnet-EVM release supports 45 or 46 yet** (latest Subnet-EVM `v0.8.0`
is protocol 44). A version mismatch means the VM plugin won't load or the L1
won't finalize blocks. Check the current matrix before deploying:
`subnet-evm` latest release's `compatibility.json` protocol number must equal the
number your chosen `avalanchego` lists in its `version/compatibility.json`.

```bash
sudo apt-get install -y tmux
tmux new -s csb
avalanche blockchain deploy csb --fuji --avalanchego-version v1.14.1
```

Prompts: pay with **csb-deployer**; *"use your local machine as a bootstrap validator?"* → **Yes** (the chain needs a validator at birth; the CLI runs one on this VM — your Docker validator joins as #2 later). Then wait: the local node bootstraps against Fuji, which takes from minutes to over an hour. Don't interrupt it; if the connection drops, `tmux attach -t csb`.

## 5. Read back the three IDs

```bash
avalanche blockchain describe csb
```

Only after a successful deploy does the output include a Fuji section with the **Subnet ID** and **Blockchain ID** (the VM ID was there since `create`). Record the three IDs — and only the IDs (reality #3) — in:

- your own `.env` (validator + app stacks on this VM),
- the project record ([`checklists.md`](checklists.md) → "Create the chain"),
- the blanks in [`validator-manual.md`](validator-manual.md) before sending it to other operators.

## 6. Continue with the existing guides — from here it's Docker

- Your own validator: `docker-compose.validator.yml` with the new `.env` ([`elestio.md`](elestio.md) §A).
- Contracts + app: `docker-compose.app.yml` — the deployer key from step 1 is the txAllowList admin the deploy profile needs ([`docker.md`](docker.md)).
- Other validator operators: send them [`validator-manual.md`](validator-manual.md) with the IDs filled in; register each NodeID they send back:

```bash
avalanche blockchain addValidator csb --fuji   # prompts for NodeID + BLS proof
```

## If something doesn't match

`avalanche-cli` prompts and flags shift between releases. The sequence (key → fund → create → deploy → describe) is stable even when the wording isn't; run the command with `--help`, or compare against the "field-tested realities" above — most surprises are already listed there.
