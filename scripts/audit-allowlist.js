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

// Selectors split into two groups deliberately. PARTICIPANT calls move or commit
// value and are what an address with no attestation should not be doing. ADMIN
// calls configure a contract and are exactly what an institutional operator
// address does. Anything unlisted is reported as unknown rather than assumed.
const PARTICIPANT_SELECTORS = {
  "0xa9059cbb": "transfer(address,uint256)",
  "0x23b872dd": "transferFrom(address,address,uint256)",
  "0x095ea7b3": "approve(address,uint256)",
  "0x617ba037": "supply(address,uint256,address,uint16)",
  "0x69328dec": "withdraw(address,uint256,address)",
  "0xa415bcad": "borrow(address,uint256,uint256,uint16,address)",
  "0x573ade81": "repay(address,uint256,uint256,address)",
};
const ADMIN_SELECTORS = {
  "0x2f2ff15d": "grantRole(bytes32,address)",
  "0xd547741f": "revokeRole(bytes32,address)",
  "0x36568abe": "renounceRole(bytes32,address)",
  "0x8456cb59": "pause()",
  "0x3f4ba83a": "unpause()",
  "0xe0823be0": "setSystemContract(address,bool)",
  "0x983b2d56": "addMinter(address)",
  "0x3092afd5": "removeMinter(address)",
  // Issuance and enforcement are role-gated in this repo, so they are operator
  // actions, not participant ones. Classifying mint as "participant" was wrong:
  // an address that can mint holds ISSUER_ROLE by definition.
  "0x40c10f19": "mint(address,uint256)",
  "0x867904b4": "issue(address,uint256)",
  "0xdadfea3c": "confiscate(address,address,uint256,bytes32)",
  "0xd9d5f8f2": "forcedTransfer(address,address,uint256,bytes32)",
  "0x5b5ba2fd": "recoveryAddress(address,address,bytes32)",
  "0xc69c09cf": "setAddressFrozen(address,bool)",
};
const INFRA_SELECTORS = {
  "0xccb5f809": "receiveCrossChainMessage(uint32,address) — an ICM relayer delivering",
  "0x62448850": "sendCrossChainMessage(...)",
  "0xbe7e1b1a": "retryMessageExecution(...)",
};
const READ_ONLY_SELECTORS = {
  "0x18160ddd": "totalSupply()",
  "0x70a08231": "balanceOf(address)",
  "0x06fdde03": "name()",
  "0x95d89b41": "symbol()",
  "0x313ce567": "decimals()",
};

/**
 * Say what an unnamed contract is, by asking it. A call target that resolves to
 * neither a deployments.json entry nor a documented constant is not actionable —
 * "this unattested address called 0xb857…" tells an auditor nothing. Probing a few
 * view functions turns it into "an ERC-20 called aKHRt" or "an ICTT token bridge",
 * which is enough to judge whether an operator address is behaving as one.
 *
 * Every probe is wrapped: a contract that does not implement a getter simply moves
 * on, and a non-contract is reported as an EOA rather than guessed at.
 */
async function identifyContract(ethers, provider, addr) {
  let code;
  try { code = await provider.getCode(addr); } catch { return null; }
  if (!code || code.length <= 2) return "plain address (no code)";

  const probes = [
    // ICM / ICTT first: these are the addresses most likely to be unnamed here,
    // because they are deployed by avalanche-cli rather than by this repo.
    ["function latestVersion() view returns (uint256)", "latestVersion",
     (v) => `TeleporterRegistry (latest version ${v})`],
    ["function tokenAddress() view returns (address)", "tokenAddress",
     (v) => `ICTT token bridge for token ${v}`],
    ["function getBlockchainID() view returns (bytes32)", "getBlockchainID",
     () => "Warp/ICM-aware contract"],
    ["function blockchainID() view returns (bytes32)", "blockchainID",
     () => "ICM-aware contract"],
    // Then the generic token shape.
    ["function symbol() view returns (string)", "symbol",
     (v) => `token, symbol ${v}`],
    ["function name() view returns (string)", "name",
     (v) => `contract named ${v}`],
  ];
  for (const [sig, fn, fmt] of probes) {
    try {
      const c = new ethers.Contract(addr, [sig], provider);
      const v = await c[fn]();
      return fmt(v);
    } catch { /* not this interface */ }
  }
  return `contract (${(code.length - 2) / 2} bytes, no recognised getter)`;
}

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

  // 2. everyone who has actually sent a transaction — they were allow-listed to do
  //    it. Record WHAT each one did at the same time: an unattested address that can
  //    transact has to be identified before it can be judged intended or not, and
  //    "which contracts did it call, did it deploy anything" identifies an operator
  //    address immediately.
  const activity = new Map();   // address -> { count, targets:Set, creates:number }
  const act = (from) => {
    const k = ethers.getAddress(from);
    if (!activity.has(k)) activity.set(k, { count: 0, targets: new Set(), creates: 0, calls: new Map() });
    return activity.get(k);
  };
  let scanned = 0;
  for (let b = scanFrom; b <= latest; b++) {
    const blk = await provider.getBlock(b, true);
    if (!blk) continue;
    scanned++;
    for (const h of blk.transactions) {
      try {
        const t = await blk.getTransaction(h);
        if (!t?.from) continue;
        note(t.from, "sent-tx");
        const a = act(t.from);
        a.count++;
        if (!t.to) a.creates++;
        else {
          const to = ethers.getAddress(t.to);
          a.targets.add(to);
          // The selector is the difference between administering a contract and
          // transacting on it, and that distinction decides whether an unattested
          // address is an operator or a participant.
          const sel = (t.data ?? "0x").slice(0, 10);
          if (sel.length === 10) {
            if (!a.calls.has(to)) a.calls.set(to, new Map());
            const m = a.calls.get(to);
            if (!m.has(sel)) m.set(sel, { ok: 0, failed: 0 });
            // WHETHER IT SUCCEEDED IS THE WHOLE POINT. A `transfer` from an
            // unattested address on a compliance-gated token is supposed to
            // REVERT — recording only that the call was attempted would report the
            // perimeter working as though it had been breached.
            let status = null;
            try { status = (await provider.getTransactionReceipt(h))?.status; }
            catch { /* receipt unavailable */ }
            if (status === 1) m.get(sel).ok++;
            else if (status === 0) m.get(sel).failed++;
          }
        }
      } catch { /* prefetch miss; skip */ }
    }
  }

  // Reverse-map deployed contract addresses to names, so a target reads as
  // "KHRStablecoin" rather than as a hex string.
  // Walk the WHOLE deployments file. An earlier version read only contracts/aave/
  // defi, so anything recorded under another key — a land or grove block — was
  // reported as an unnamed contract and looked far more suspicious than it was.
  const known = new Map();
  const walk = (node, path) => {
    if (typeof node === "string") {
      if (ethers.isAddress(node)) known.set(ethers.getAddress(node), path);
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      // Never index a value under a secret-looking key, so a private key in this
      // file cannot end up printed as a label.
      if (/^(key|privateKey|private_key|mnemonic|secret|seed)$/i.test(k)) continue;
      walk(v, path ? `${path}.${k}` : k);
    }
  };
  walk(d, "");
  // Addresses with a fixed, published meaning. Worth naming because each one looks
  // alarming in this report and is in fact expected.
  const WELL_KNOWN = {
    "0x618FEdD9A45a8C456812ecAAE70C671c6249DfaC":
      "ICM/Teleporter deterministic deployer — expected, see docs/fuji-ictt.md",
    "0x253b2784c75e510dD0fF1da844684a1aC0aa5fcf":
      "ICM Messenger (Teleporter) — see docs/deployment-status.md",
  };

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
      console.log(`\n  WHAT EACH ONE HAS ACTUALLY DONE (to identify it):`);
      for (const r of neverKyc) {
        const wk = WELL_KNOWN[r.addr];
        const a = activity.get(r.addr);
        const bal = await provider.getBalance(r.addr).catch(() => null);
        console.log(`\n    ${r.addr}`);
        if (wk) console.log(`      KNOWN: ${wk}`);
        console.log(`      transactions in range: ${a?.count ?? 0}`
          + `${a?.creates ? `, deployed ${a.creates} contract(s)` : ""}`);
        if (bal !== null) console.log(`      balance: ${ethers.formatEther(bal)} tRIEL`);
        const targets = [...(a?.targets ?? [])];
        if (targets.length) {
          console.log(`      called:`);
          for (const t of targets.slice(0, 8)) {
            let label = known.get(t) ?? WELL_KNOWN[t];
            // Nothing named it, so ask the chain rather than print a bare hex string.
            if (!label) label = await identifyContract(ethers, provider, t);
            console.log(`        ${t}${label ? `  (${label})` : ""}`);
            for (const [sel, c] of (a?.calls.get(t) ?? new Map())) {
              const pn = PARTICIPANT_SELECTORS[sel];
              const an = ADMIN_SELECTORS[sel];
              const rn = READ_ONLY_SELECTORS[sel] ?? INFRA_SELECTORS[sel];
              let kind = pn ? "PARTICIPANT" : an ? "admin"
                : INFRA_SELECTORS[sel] ? "infrastructure" : rn ? "read" : "unknown";
              // A participant call that only ever REVERTED is the perimeter doing
              // its job, and must not read the same as one that went through.
              if (pn && c.ok === 0 && c.failed > 0) kind = "PARTICIPANT, ALL REVERTED";
              console.log(`          ${sel}  ${pn ?? an ?? rn ?? "(selector not in dictionary)"}`
                + `  [${kind}]  ${c.ok} succeeded, ${c.failed} reverted`);
            }
            // WHICH REGISTRY DOES THIS TOKEN TRUST? A successful transfer by an
            // address with no attestation looks like a compliance breach and is
            // usually something duller and still worth knowing: an orphaned token
            // from an earlier deployment, gated by an EARLIER IdentityRegistry in
            // which the sender is perfectly valid. Reading the token's own
            // `identity` immutable settles it, and reporting a breach without
            // checking would be a fabricated finding.
            try {
              const tc = new ethers.Contract(t,
                ["function identity() view returns (address)"], provider);
              const reg = await tc.identity();
              if (ethers.isAddress(reg)) {
                const same = ethers.getAddress(reg) === ethers.getAddress(idAddr);
                console.log(`          gated by IdentityRegistry ${reg}`
                  + `${same ? "  (the one audited above)" : "  <-- A DIFFERENT REGISTRY"}`);
                if (!same) {
                  // Ask the registry this token actually trusts.
                  try {
                    const other = new ethers.Contract(reg, IDENTITY_ABI, provider);
                    const st = Number((await other.attestationOf(r.addr)).status);
                    console.log(`          in THAT registry this address is: `
                      + `${STATUS_NAMES[st] ?? st}`);
                    if (st === 1) {
                      console.log(`          => NOT a compliance breach. This is a STALE`);
                      console.log(`             deployment: the token is gated by a registry`);
                      console.log(`             that is no longer the chain's active one, and`);
                      console.log(`             the sender is attested there. Still worth`);
                      console.log(`             fixing — an orphaned gated token remains`);
                      console.log(`             transferable under abandoned governance.`);
                    }
                  } catch { console.log(`          (that registry did not answer)`); }
                }
              }
            } catch { /* not a gated token of this shape */ }

            // Role membership settles the ambiguity that a selector cannot: an
            // address holding an admin role on the contract is an operator by
            // construction, whatever it happened to call.
            for (const [rn, rid] of [
              ["DEFAULT_ADMIN_ROLE", ethers.ZeroHash],
              ["ISSUER_ROLE", ethers.id("ISSUER_ROLE")],
              ["ENFORCER_ROLE", ethers.id("ENFORCER_ROLE")],
              ["AGENT_ROLE", ethers.id("AGENT_ROLE")],
              ["REGISTRAR_ROLE", ethers.id("REGISTRAR_ROLE")],
            ]) {
              try {
                const c = new ethers.Contract(t,
                  ["function hasRole(bytes32,address) view returns (bool)"], provider);
                if (await c.hasRole(rid, r.addr)) {
                  console.log(`          holds ${rn} on this contract -> operator, not participant`);
                }
              } catch { /* not an AccessControl contract */ }
            }
          }
          if (targets.length > 8) console.log(`        …and ${targets.length - 8} more`);
        }
      }
      console.log(`\n    An address that only deployed contracts, or only called`);
      console.log(`    infrastructure, is an operator address and is fine. One that`);
      console.log(`    called KHRStablecoin or the Aave pool is acting like a`);
      console.log(`    participant without an attestation, and needs explaining.`);
    }
  } else {
    console.log(`\nNo gap found in what could be enumerated. Note the limit: an`);
    console.log(`allow-listed address that never sent a transaction and was never`);
    console.log(`registered cannot be discovered from chain data.`);
  }

  console.log(`\nWhy this matters: docs/architecture.md §5, docs/defi.md.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
