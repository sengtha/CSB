const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Find addresses that can still TRANSACT but hold no valid KYC attestation.
 * Read-only; no key, no transactions.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/audit-allowlist.js --network csbRemote
 *
 * WHY THIS EXISTS. CSB has two independent gates and they are not wired together:
 *
 *   txAllowList (precompile 0x…02)  decides who may SEND a transaction
 *   IdentityRegistry (contract)     decides who holds a KYC attestation
 *
 * `IdentityRegistry.revoke()` and `suspend()` change only the attestation. Nothing
 * calls `setNone` on the precompile — allow-list entries are granted by hand
 * (`scripts/allow-dev.js`) and removed by hand, if at all. So **revoking someone's
 * KYC does not stop them transacting.** They cannot hold KHRt afterwards, because
 * KHRt checks the registry on transfer, but they can still send transactions, still
 * receive uncompliant receipt tokens such as aTokens or LP shares, and still call
 * `pool.withdraw(asset, amount, someAttestedAddress)` to convert such a claim into
 * real KHRt in an attested party's hands.
 *
 * That is the gap this script measures. It is an operational decoupling, not a flaw
 * in any contract, and it is invisible unless the two gates are compared directly.
 *
 * HOW IT ENUMERATES. The precompile has no "list everyone" call, so candidates are
 * gathered from three places and merged:
 *
 *   1. IdentityRegistry events — every address ever registered, and its current
 *      status. This finds revoked and suspended addresses, the ones that matter.
 *   2. Transaction senders in the block range — every one of them WAS allow-listed
 *      at the time, so this finds addresses granted access with no attestation.
 *   3. app/deployments.json — pilots and system addresses.
 *
 * The result is therefore a lower bound: an allow-listed address that has never
 * sent a transaction and was never registered cannot be discovered this way. It is
 * still the right question asked the right way round — start from who can act.
 */

const TX_ALLOW_LIST = "0x0200000000000000000000000000000000000002";
const DEPLOYER_ALLOW_LIST = "0x0200000000000000000000000000000000000000";
const ROLE_NAMES = { 0: "none", 1: "enabled", 2: "admin", 3: "manager" };
const STATUS_NAMES = { 0: "None", 1: "Active", 2: "Suspended", 3: "Revoked" };

const IDENTITY_ABI = [
  "function attestationOf(address) view returns (tuple(bytes32 identity, uint8 tier, uint8 status, uint64 issuedAt))",
  "function isActive(address) view returns (bool)",
  "event AddressRegistered(address indexed account, bytes32 indexed identity, uint8 tier)",
  "event AddressRevoked(address indexed account, bytes32 indexed identity)",
  "event AddressSuspended(address indexed account, bytes32 indexed identity)",
  "event AddressReactivated(address indexed account, bytes32 indexed identity)",
];
const ALLOWLIST_ABI = ["function readAllowList(address) view returns (uint256)"];

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const idAddr = d.contracts?.IdentityRegistry;
  if (!idAddr) throw new Error("No contracts.IdentityRegistry in deployments.json");

  // The precompile addresses are fixed on a subnet-evm chain. They are overridable
  // only so this script can be exercised against a MockAllowList on a network that
  // has no precompiles — never point them anywhere else on a real chain.
  const txAllowAddr = process.env.CSB_TX_ALLOWLIST ?? TX_ALLOW_LIST;
  const depAllowAddr = process.env.CSB_DEPLOYER_ALLOWLIST ?? DEPLOYER_ALLOW_LIST;
  if (txAllowAddr !== TX_ALLOW_LIST) {
    console.log(`\n!! txAllowList overridden to ${txAllowAddr} — TEST MODE, not the precompile.`);
  }

  const identity = new ethers.Contract(idAddr, IDENTITY_ABI, provider);
  const txAllow = new ethers.Contract(txAllowAddr, ALLOWLIST_ABI, provider);
  const depAllow = new ethers.Contract(depAllowAddr, ALLOWLIST_ABI, provider);

  const latest = await provider.getBlockNumber();
  const scanFrom = Number(process.env.CSB_FROM_BLOCK ?? 0);
  console.log(`\nChain ${(await provider.getNetwork()).chainId}, blocks ${scanFrom}..${latest}`);
  console.log(`IdentityRegistry ${idAddr}\n`);

  const candidates = new Map();   // address -> Set of reasons it was considered
  const note = (addr, why) => {
    if (!addr || addr === ethers.ZeroAddress) return;
    const k = ethers.getAddress(addr);
    if (!candidates.has(k)) candidates.set(k, new Set());
    candidates.get(k).add(why);
  };

  // 1. everyone the registry has ever heard of
  for (const [ev, why] of [
    ["AddressRegistered", "registered"], ["AddressRevoked", "revoked-event"],
    ["AddressSuspended", "suspended-event"], ["AddressReactivated", "reactivated-event"],
  ]) {
    try {
      for (const l of await identity.queryFilter(identity.filters[ev](), scanFrom, latest)) {
        note(l.args.account, why);
      }
    } catch (e) {
      console.log(`  (could not read ${ev}: ${e.shortMessage ?? e.message})`);
    }
  }

  // 2. everyone who has actually sent a transaction — they were allow-listed to do it
  let scanned = 0;
  for (let b = scanFrom; b <= latest; b++) {
    const blk = await provider.getBlock(b, true);
    if (!blk) continue;
    scanned++;
    for (const h of blk.transactions) {
      try {
        const t = await blk.getTransaction(h);
        if (t?.from) note(t.from, "sent-tx");
      } catch { /* prefetch miss; skip */ }
    }
  }

  // 3. anything named in deployments.json
  for (const [k, v] of Object.entries(d.accounts ?? {})) {
    if (typeof v === "string" && ethers.isAddress(v)) note(v, `deployments:${k}`);
    else if (v && typeof v === "object" && ethers.isAddress(v.address ?? "")) {
      note(v.address, `deployments:${k}`);
    }
  }

  console.log(`Scanned ${scanned} blocks; ${candidates.size} distinct addresses to check.\n`);

  const rows = [];
  for (const [addr, why] of candidates) {
    let role = null, status = null, isContract = false;
    try { role = Number(await txAllow.readAllowList(addr)); } catch { /* precompile absent */ }
    try {
      const a = await identity.attestationOf(addr);
      status = Number(a.status);
    } catch { /* registry unreadable for this address */ }
    try { isContract = (await provider.getCode(addr)).length > 2; } catch { /* ignore */ }
    let depRole = null;
    try { depRole = Number(await depAllow.readAllowList(addr)); } catch { /* ignore */ }
    rows.push({ addr, role, status, isContract, depRole, why: [...why].join(",") });
  }

  // THE GAP: can transact, but holds no active attestation. Contracts are listed
  // separately — a contract cannot hold an attestation and is not expected to.
  const gap = rows.filter((r) => r.role > 0 && r.status !== 1 && !r.isContract);
  const revoked = gap.filter((r) => r.status === 3 || r.status === 2);
  const neverKyc = gap.filter((r) => r.status === 0 || r.status === null);
  const ok = rows.filter((r) => r.role > 0 && r.status === 1);
  const inert = rows.filter((r) => r.role === 0);

  console.log(`SUMMARY`);
  console.log(`  can transact AND attested (as intended)   ${ok.length}`);
  console.log(`  can transact, NO active attestation       ${gap.length}   <-- the gap`);
  console.log(`    of which revoked or suspended           ${revoked.length}`);
  console.log(`    of which never attested                 ${neverKyc.length}`);
  console.log(`  cannot transact (role none)               ${inert.length}`);

  if (gap.length) {
    console.log(`\nADDRESSES THAT CAN TRANSACT WITHOUT AN ACTIVE ATTESTATION`);
    for (const r of gap) {
      console.log(`  ${r.addr}  txAllowList: ${ROLE_NAMES[r.role] ?? r.role}`
        + `  KYC: ${STATUS_NAMES[r.status] ?? "unknown"}`
        + `${r.depRole > 0 ? `  deployer-allowlist: ${ROLE_NAMES[r.depRole]}` : ""}`
        + `  [${r.why}]`);
    }
    if (revoked.length) {
      console.log(`\n  ** ${revoked.length} address(es) had an attestation REVOKED or SUSPENDED and can`);
      console.log(`     still send transactions. Revocation does not touch the precompile.`);
      console.log(`     They cannot hold KHRt, but they can hold and move uncompliant`);
      console.log(`     receipt tokens (aTokens, LP shares) and redeem them to an`);
      console.log(`     attested address. Remove access explicitly:`);
      console.log(`       txAllowList.setNone(<address>)   // precompile 0x…02, admin only`);
    }
    if (neverKyc.length) {
      console.log(`\n  ${neverKyc.length} address(es) can transact with no attestation ever issued —`);
      console.log(`  expected for operator/dev addresses granted via scripts/allow-dev.js.`);
      console.log(`  Confirm each is intended, and that none is a citizen-facing account.`);
    }
  } else {
    console.log(`\nNo gap found in what could be enumerated. Note the limit: an`);
    console.log(`allow-listed address that never sent a transaction and was never`);
    console.log(`registered cannot be discovered from chain data.`);
  }

  console.log(`\nWhy this matters: docs/architecture.md §5, docs/defi.md.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
