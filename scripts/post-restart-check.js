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

/**
 * Not every empty address is a lost contract, and saying so matters more than it
 * sounds. The first run of this reported 25 addresses with no code and asked the
 * operator to work out which mattered — on a chain that had just come back from
 * an outage, at the exact moment nobody wants to be reading a list. A checker
 * that raises 25 explainable alarms is one nobody runs twice.
 *
 * Two kinds of address legitimately have no code HERE:
 *
 *   account   never had any. Deployer, role holders, the pilot personas.
 *   elsewhere real contracts, on Fuji. deployments.json spans both sides of the
 *             bridge, so the Fuji halves are absent from CSB by definition —
 *             ictt.tokenRemote is the far end of CSB's egress home, and
 *             bridgeHomes/homeAddress are the Fuji end of the USDC ingress.
 *
 * Anything else with no code is a real finding. Override with CSB_ACCOUNTS /
 * CSB_ELSEWHERE if the file's shape changes; the point is that the exceptions
 * are declared and auditable rather than assumed by whoever reads the output.
 */
const EXPECTED_EMPTY = [
  { kind: "account",   re: new RegExp(process.env.CSB_ACCOUNTS
      ?? "^roles\\.|^pilot\\..*\\.address$|publisher$") },
  { kind: "elsewhere", re: new RegExp(process.env.CSB_ELSEWHERE
      ?? "^bridgeHomes\\.|homeAddress$|^ictt\\.tokenRemote$") },
];

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

  const unreadable = [], lost = [], counts = { account: 0, elsewhere: 0, code: 0 };
  const width = Math.max(...found.map(([p]) => p.length), 4);
  for (const [where, addr] of found) {
    const c = code.get(addr.toLowerCase());
    let verdict;
    if (c === null) {
      verdict = "UNREADABLE";
      unreadable.push(where);
    } else if (c === "0x") {
      const expected = EXPECTED_EMPTY.find((e) => e.re.test(where));
      if (expected) {
        verdict = `no code — ${expected.kind}`;
        counts[expected.kind]++;
      } else {
        verdict = "NO CODE — expected a contract";
        lost.push([where, addr]);
      }
    } else {
      verdict = `${((c.length - 2) / 2).toLocaleString("en-US")} bytes`;
      counts.code++;
    }
    console.log(`  ${where.padEnd(width)}  ${addr}  ${verdict}`);
  }

  console.log("");
  console.log(`${counts.code} with code · ${counts.account} accounts · `
    + `${counts.elsewhere} on another chain · ${lost.length} unexplained`);
  console.log("");

  if (unreadable.length) {
    console.log(`${unreadable.length} address(es) could not be read at all — the chain`);
    console.log(`answered an error rather than a result. That is a node problem, not a`);
    console.log(`missing contract: ${unreadable.join(", ")}`);
    process.exitCode = 1;
  } else if (lost.length) {
    console.log(`MISSING. These are recorded as contracts and have no code on this chain:`);
    for (const [where, addr] of lost) console.log(`  ${where}  ${addr}`);
    console.log(``);
    console.log(`Either the chain lost state, or the entry belongs to another chain and`);
    console.log(`this script does not know it yet — see EXPECTED_EMPTY. Do not redeploy`);
    console.log(`over the gap before deciding which: redeploying forks the compliance`);
    console.log(`perimeter rather than migrating it (docs/todo.md item 1).`);
    process.exitCode = 1;
  } else {
    console.log(`Nothing was lost. Every recorded contract still has code, and every`);
    console.log(`empty address is one that is supposed to be empty.`);
  }
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
