# Working on CSB

Facts that are expensive to rediscover, and a few that are expensive to get
wrong. Everything else is in `docs/`.

## The checkout is `/opt/csb`

**Not `~/csb`.** That path does not exist on the deployment VM. It is an easy
habit to pick up and it fails silently: pull into the wrong directory, restart,
and the change is simply absent with no error anywhere.

```bash
cd /opt/csb
source ops/csb-env.sh          # sets CSB_RPC_URL, CSB_CHAIN_ID, deployer key
```

`ops/csb-env.sh` derives `CSB_HOME` from its own location, so sourcing it from a
clone elsewhere still works — but every instruction written for the operator
should say `/opt/csb`.

To find where a *running* app server was started from, ask it rather than assume:

```bash
readlink /proc/$(pgrep -f '[a]pp/server.js' | head -1)/cwd
```

## Never do these

- **`avalanche node local destroy`** — deletes the cluster and every contract on
  it. There is no undo and no backup of chain state.
- **Print or paste the deployer private key.** It is the chain's root authority:
  precompile admin, KHRt issuer, validator-manager owner. `ops/csb-env.sh` reads
  it from the avalanche-cli keystore so it is never typed.
- **`avalanche blockchain describe csb`** unfiltered — it dumps private keys in
  plain text. This is how the deployer key was already burned. Use:
  `avalanche blockchain describe csb | grep -v -iE 'private|[0-9a-f]{64}'`
- **`avalanche key import`** for a personal wallet — it writes the key in plain
  text to a directory `describe` prints from.
- **Expose the node RPC ports (9650/9652) to the internet.** P2P (9651/9653) is
  the only thing that may be public.
- **`pkill -f '<pattern>'`** where the pattern also matches your own shell's
  command line. The `[p]attern` bracket trick only stops pgrep matching itself.
  This has killed the working shell twice. Filter on
  `readlink /proc/$PID/exe` instead — see `ops/csb-restart-app.sh`.

## Untracked files that matter

`app/deployments.json` and `app/kyc-requests.json` are gitignored because they
hold **private keys and typed names**. They are the source of truth for every
deployed address; the copy in a fresh clone is stale or absent.

## Two clocks

- **Validator AVAX balance.** Reaches zero, validator is deactivated, chain
  stops, no warning. Check with `bash ops/csb-nodes.sh` section 3.
- **Mandatory client upgrades.** A missed one does not stop a running chain — it
  removes its ability to ever restart, and the gap before anyone notices is
  however long until something restarts. This took CSB out on 2026-07-28 and was
  found on 08-02. `ops/csb-upgrade-avalanchego.sh`, `docs/architecture.md` §2.

## Conventions

- Push to `main` directly.
- This is a personal experiment, not government-backed. Institutions named in
  docs are placeholders; do not describe adoption that has not happened.
- Scripts carry a header comment explaining *why*, not just usage — including
  what was tried and rejected. That is the house style, and the reason several
  of these traps are only documented once.
