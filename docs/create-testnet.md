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
3. edit genesis (0xC0DE… → your 0x address), then
   avalanche blockchain create csb …           → mints the VM ID
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
5. **The CLI wizard is a trap for this project.** If `create` asks about chain ID, token airdrops, or "defaults for a test environment", the `--genesis` flag didn't take effect and you're building a generic chain (no zero fees, no allowlists, prefunded with the public "ewoq" test key — Fuji will refuse it with *"can't airdrop to default address on public networks"*). Recreate with `--force` and the full flag set from step 3.
6. **Interrupted deploys are resumable.** Re-running `avalanche blockchain deploy csb --fuji` picks up what already completed on Fuji. Check `avalanche key list` afterwards — an interrupted attempt may have spent some P-Chain AVAX, so the retry can need a faucet top-up.

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

## 3. Put your address into the genesis, then create the blockchain

Replace every `0xC0DE…` placeholder in `chain/genesis.example.json` (four precompile `adminAddresses` + the `alloc` funding key) with your deployer's 0x address in one command, and verify:

```bash
cd ~/csb
sed -i "s/C0DE000000000000000000000000000000000001/<YOUR-0X-ADDRESS-WITHOUT-0x>/g" chain/genesis.example.json
grep -c "<YOUR-0X-ADDRESS-WITHOUT-0x>" chain/genesis.example.json   # must print 5
```

Then create — note the **pinned `--vm-version`**: the CLI otherwise picks the newest Subnet-EVM, which may only be compatible with a release-candidate AvalancheGo, mismatching the stable version the Docker validator uses:

```bash
avalanche blockchain create csb --force \
  --genesis chain/genesis.example.json \
  --evm --proof-of-authority --vm-version v0.7.9
```

Expected prompts and answers:

- *"Which address … controller of ValidatorManager contract?"* → **Get address from an existing stored key** → `csb-deployer`. (This is the validator add/remove authority — the slot a Governing Council multisig takes in a production deployment.)
- *"Do you want to connect your blockchain with other blockchains or the C-Chain?"* → **Yes** — the egress gateway runs on ICM/ICTT; "isolated" would mean redoing this manually later. Enabling interop installs plumbing only; nothing leaves except through the gateway's policy.
- Token name/symbol → cosmetic metadata, e.g. `tRIEL`.
- It must **not** ask about chain ID or airdrops (see reality #5).

Sanity-check before spending AVAX:

```bash
avalanche blockchain describe csb --genesis | grep -E 'chainId|minBaseFee|txAllowList'
# expect: "chainId": 8555 · "minBaseFee": 0 · a txAllowListConfig section
```

## 4. Deploy to Fuji — in tmux

```bash
sudo apt-get install -y tmux
tmux new -s csb
avalanche blockchain deploy csb --fuji
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
