#!/usr/bin/env node
/**
 * Patch the chain config that an avalanche-cli local node ACTUALLY reads.
 *
 *     node ops/csb-patch-chain-config.js            # show what would change
 *     node ops/csb-patch-chain-config.js --write    # write it (backs up first)
 *
 * Why this is not just a file in configs/chains/<id>/config.json: avalanche-cli
 * does not use the chain-config directory. It passes the whole thing inline, as
 * base64, in each node's own config.json under `flags.chain-config-content`.
 * Files written into configs/chains are read by nobody — which behaves exactly
 * like a setting that does not work, and cost several rounds of debugging to
 * pin down.
 *
 * The value is base64 TWICE:
 *   flags["chain-config-content"]           base64 of
 *     { "<blockchainID>": { "Config": ... } }   where Config is base64 of
 *       { "log-level": ..., "eth-apis": [...] } the actual chain config
 *
 * Changes made:
 *   rpc-tx-fee-cap: 0   — the node refuses transactions whose total fee exceeds
 *       this (default 100). CSB's native token is one riel, so 100 tRIEL is
 *       about 2.5 US cents, and pricing gas at 1 riel per transfer makes an
 *       ordinary contract deployment cost 100.35 tRIEL. Deployments fail on a
 *       rail meant for tokens worth real money.
 *   eth-apis += internal-txpool — lets the watchdog tell an idle chain from a
 *       wedged one. Never expose this on a public RPC; mempool contents leak
 *       pending transactions.
 *
 * Existing settings are preserved, including the "admin" API this cluster
 * already enables — which is another reason port 9650 must stay on localhost.
 * Requires a node restart to take effect.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const CLUSTER = process.env.CSB_CLUSTER ?? "csb-local-node-fuji";
const ROOT = process.env.CSB_CLUSTER_ROOT ?? path.join(os.homedir(), ".avalanche-cli", "local", CLUSTER);
const WRITE = process.argv.includes("--write");

const b64d = (s) => Buffer.from(s, "base64").toString("utf8");
const b64e = (s) => Buffer.from(s, "utf8").toString("base64");

function patchChainConfig(cfg) {
  const before = JSON.stringify(cfg);
  const changes = [];

  if (cfg["rpc-tx-fee-cap"] !== 0) {
    changes.push(`rpc-tx-fee-cap: ${cfg["rpc-tx-fee-cap"] ?? "(unset, defaults to 100)"} → 0`);
    cfg["rpc-tx-fee-cap"] = 0;
  }
  const apis = Array.isArray(cfg["eth-apis"]) ? cfg["eth-apis"] : [];
  if (!apis.includes("internal-txpool")) {
    apis.push("internal-txpool");
    cfg["eth-apis"] = apis;
    changes.push("eth-apis: + internal-txpool");
  }
  return { changed: JSON.stringify(cfg) !== before, changes, cfg };
}

function processNode(nodeDir) {
  const file = path.join(nodeDir, "config.json");
  if (!fs.existsSync(file)) return { node: path.basename(nodeDir), skipped: "no config.json" };

  const raw = fs.readFileSync(file, "utf8");
  let node;
  try { node = JSON.parse(raw); } catch (e) { return { node: path.basename(nodeDir), skipped: `unparsable: ${e.message}` }; }

  const content = node?.flags?.["chain-config-content"];
  if (!content) return { node: path.basename(nodeDir), skipped: "no flags.chain-config-content" };

  let outer;
  try { outer = JSON.parse(b64d(content)); }
  catch (e) { return { node: path.basename(nodeDir), skipped: `outer not JSON: ${e.message}` }; }

  const allChanges = [];
  for (const [chainId, entry] of Object.entries(outer)) {
    if (!entry || typeof entry !== "object" || typeof entry.Config !== "string") continue;
    let cfg;
    try { cfg = JSON.parse(b64d(entry.Config)); }
    catch (e) { allChanges.push(`${chainId}: inner not JSON (${e.message}) — skipped`); continue; }

    const { changed, changes, cfg: patched } = patchChainConfig(cfg);
    if (changed) {
      entry.Config = b64e(JSON.stringify(patched, null, 2));
      allChanges.push(...changes.map((c) => `${chainId.slice(0, 12)}…  ${c}`));
    }
  }

  if (allChanges.length === 0) {
    return { node: path.basename(nodeDir), skipped: "already up to date" };
  }

  node.flags["chain-config-content"] = b64e(JSON.stringify(outer));

  if (WRITE) {
    // Keep exactly one backup of the original, so a second run cannot overwrite
    // the pristine copy with an already-patched one.
    const backup = `${file}.orig`;
    if (!fs.existsSync(backup)) fs.copyFileSync(file, backup);
    fs.writeFileSync(file, JSON.stringify(node, null, 2));
  }
  return { node: path.basename(nodeDir), changes: allChanges };
}

function main() {
  if (!fs.existsSync(ROOT)) {
    console.error(`No cluster at ${ROOT}`);
    console.error(`Set CSB_CLUSTER_ROOT, or check: avalanche node local list`);
    process.exit(1);
  }
  const nodes = fs.readdirSync(ROOT)
    .filter((d) => d.startsWith("NodeID-"))
    .map((d) => path.join(ROOT, d))
    .filter((d) => fs.statSync(d).isDirectory());

  if (nodes.length === 0) { console.error(`No NodeID-* directories under ${ROOT}`); process.exit(1); }

  console.log(`Cluster ${CLUSTER} — ${nodes.length} node(s)`);
  console.log(WRITE ? "Mode: WRITE\n" : "Mode: dry run (pass --write to apply)\n");

  let touched = 0;
  for (const n of nodes) {
    const r = processNode(n);
    if (r.skipped) { console.log(`  ${r.node}\n      ${r.skipped}`); continue; }
    touched++;
    console.log(`  ${r.node}`);
    for (const c of r.changes) console.log(`      ${c}`);
  }

  if (touched === 0) {
    console.log("\nNothing to change.");
    return;
  }
  if (!WRITE) {
    console.log(`\nDry run. Apply with:\n    node ops/csb-patch-chain-config.js --write`);
    return;
  }
  console.log(`\nPatched ${touched} node(s). Originals saved as config.json.orig`);
  console.log(`\nRestart for it to take effect:`);
  console.log(`    export PATH=$PATH:$HOME/bin`);
  console.log(`    avalanche node local stop ${CLUSTER} && avalanche node local start ${CLUSTER}`);
  console.log(`\nThen verify — txpool_status answering means the node read this config,`);
  console.log(`so the fee cap is lifted too (both settings are in the same blob):`);
  console.log(`    source /opt/csb/ops/csb-env.sh`);
  console.log(`    curl -s -X POST -H 'content-type:application/json' \\`);
  console.log(`      --data '{"jsonrpc":"2.0","id":1,"method":"txpool_status","params":[]}' $CSB_RPC_URL; echo`);
}

main();
