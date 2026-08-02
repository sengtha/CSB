const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Did the chain come back with everything it had? Read-only.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/post-restart-check.js --network csbRemote
 *
 * WHY THIS EXISTS. "The chain is serving RPC" and "the chain still has your
 * contracts" are different claims, and an outage can satisfy the first while
 * failing the second. The specific scare was CSB missing Fuji's Helicon fork on
 * 2026-07-28 (docs/architecture.md §2): the upgraded Subnet-EVM refused to start
 * with `rewindto timestamp 1785250799`, and a chain that had actually rewound to
 * a second before the fork would come back healthy, at a believable height, with
 * every contract deployed after that moment silently gone. A height alone does
 * not distinguish the two — only asking whether the code is still there does.
 *
 * So this walks every address recorded in deployments.json, whatever shape the
 * file has grown into, and asks the chain for its code. An address is looked up
 * by where it sits in the JSON rather than by a hardcoded list, because the list
 * has changed every time something new was deployed and a checker that needs
 * editing after each deploy is a checker that stops being run.
 *
 * It also prints the head block's timestamp against the Helicon activation, which
 * is what actually answers "did we lose the blocks after the fork".
 *
 * Environment, all optional:
 *   CSB_DEPLOYMENTS_FILE   path to deployments.json  (default app/deployments.json)
 *   CSB_FORK_TS            fork timestamp to compare against    (default Helicon)
 */

const HELICON = 1785250800; // 2026-07-28T15:00:00Z — Fuji's activation
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = "0x0000000000000000000000000000000000000000";

const iso = (t) => new Date(Number(t) * 1000).toISOString().replace(".000", "");

/** Collect every [jsonPath, address] pair, at any depth. */
function addresses(node, trail = []) {
  if (typeof node === "string") {
    return ADDRESS.test(node) && node !== ZERO ? [[trail.join("."), node]] : [];
  }
  if (Array.isArray(node)) {
    return node.flatMap((v, i) => addresses(v, [...trail, i]));
  }
  if (node && typeof node === "object") {
    return Object.entries(node).flatMap(([k, v]) => addresses(v, [...trail, k]));
  }
  return [];
}

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const forkTs = Number(process.env.CSB_FORK_TS ?? HELICON);

  const net = await provider.getNetwork();
  const head = await provider.getBlock("latest");
  console.log(`Chain        ${net.chainId}`);
  console.log(`Head         #${head.number}  ${iso(head.timestamp)}`);

  // The question a rewind would answer differently.
  if (head.timestamp >= forkTs) {
    console.log(`Fork         head is AFTER the ${iso(forkTs)} activation — no rewind`);
  } else {
    console.log(`Fork         head is BEFORE the ${iso(forkTs)} activation`);
    console.log(`             If this chain was producing blocks past that moment,`);
    console.log(`             it rewound and everything after it is gone.`);
  }

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  if (!fs.existsSync(file)) {
    console.log(`\nNo ${file} — nothing recorded to check.`);
    return;
  }

  const found = addresses(JSON.parse(fs.readFileSync(file, "utf8")));
  // The same contract is often recorded under several keys; ask the chain once.
  const unique = [...new Map(found.map(([, a]) => [a.toLowerCase(), a])).values()];
  console.log(`\n${found.length} address entries, ${unique.length} distinct, from ${path.basename(file)}\n`);

  const code = new Map();
  for (const a of unique) {
    // One bad entry must not hide the state of every entry after it.
    code.set(a.toLowerCase(), await provider.getCode(a).catch(() => null));
  }

  let missing = 0, eoa = 0;
  const width = Math.max(...found.map(([p]) => p.length), 4);
  for (const [where, addr] of found) {
    const c = code.get(addr.toLowerCase());
    let verdict;
    if (c === null) { verdict = "UNREADABLE"; missing++; }
    else if (c === "0x") {
      // Not every recorded address is a contract — deployer and treasury
      // addresses live in here too, and they are supposed to have no code.
      verdict = "no code (EOA?)"; eoa++;
    } else {
      verdict = `${((c.length - 2) / 2).toLocaleString("en-US")} bytes`;
    }
    console.log(`  ${where.padEnd(width)}  ${addr}  ${verdict}`);
  }

  console.log("");
  if (missing) {
    console.log(`${missing} address(es) could not be read — the chain answered an error.`);
    process.exitCode = 1;
  } else if (eoa) {
    console.log(`Every contract is present. ${eoa} entr${eoa === 1 ? "y has" : "ies have"} no code,`);
    console.log(`which is expected for accounts (deployer, treasury) but would be a lost`);
    console.log(`deployment for anything that should be a contract — check the names above.`);
  } else {
    console.log(`Every recorded address still has code. Nothing was lost.`);
  }
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
