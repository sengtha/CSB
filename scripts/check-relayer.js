const { ethers } = require("ethers");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Show what the ICM relayer will and will not carry, before you rely on it.
 *
 *   node scripts/check-relayer.js
 *   CSB_RELAYER_CONFIG=/path/to/icm-relayer-config.json node scripts/check-relayer.js
 *
 * WHY THIS EXISTS. A relayer configured for one ICTT pair usually carries a second
 * pair on the same two chains for free — but not always. The config supports
 * `allowed-origin-sender-addresses` and `allowed-destination-addresses`, and when
 * those are populated they are the ONLY addresses relayed. A new TokenHome/TokenRemote
 * then emits messages nobody delivers.
 *
 * That failure is silent and looks like something else entirely: the send succeeds,
 * gas is spent, the event fires, and the tokens simply never arrive. Everyone goes
 * looking at the bridge contracts, because the relayer is visibly running.
 *
 * NEVER PRINTS SECRETS. The relayer config contains `account-private-key` per
 * destination chain, which is why this reads specific fields rather than dumping the
 * file. Any value that looks like a key is replaced before output, so the result is
 * safe to paste into a ticket or a chat.
 */

const DEFAULT_CONFIG = path.join(
  os.homedir(), ".avalanche-cli", "runs", "Fuji", "local-relayer", "icm-relayer-config.json");

// Known chain IDs from docs/fuji-ictt.md, so the output names chains rather than
// making somebody match 32-byte hex by eye.
const KNOWN = {
  "0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5": "Fuji C-Chain",
  "yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp": "Fuji C-Chain",
  "0x9633e7227257f4de7dcd8e595bfafdd8cf6f88918926dd1d4e2ddfff46978a61": "CSB",
  "299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW": "CSB",
};

const SECRETISH = /^(0x)?[0-9a-fA-F]{64}$/;
const label = (id) => `${KNOWN[id] ?? "unknown chain"}  ${String(id).slice(0, 20)}…`;
const safe = (v) => (typeof v === "string" && SECRETISH.test(v) ? "<redacted>" : v);

async function main() {
  const file = process.env.CSB_RELAYER_CONFIG ?? DEFAULT_CONFIG;
  if (!fs.existsSync(file)) {
    throw new Error(`No relayer config at ${file}\n`
      + `  Set CSB_RELAYER_CONFIG, or find it with:\n`
      + `    ps aux | grep -i icm-relayer | grep -v grep`);
  }

  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`Config ${file}`);
  console.log(`Log level: ${cfg["log-level"] ?? "(default — likely 'error', which hides everything useful)"}\n`);

  const sources = cfg["source-blockchains"] ?? [];
  const dests = cfg["destination-blockchains"] ?? [];
  const warnings = [];

  console.log(`SOURCES — chains it watches for outgoing messages (${sources.length})`);
  for (const s of sources) {
    const id = s["blockchain-id"];
    console.log(`  ${label(id)}`);
    const allowed = s["allowed-origin-sender-addresses"] ?? [];
    if (allowed.length) {
      console.log(`    ONLY relays messages sent by:`);
      for (const a of allowed) console.log(`      ${safe(a)}`);
      warnings.push(`${KNOWN[id] ?? id} restricts origin senders — a NEW TokenHome/`
        + `TokenRemote on this chain will NOT be relayed until it is added.`);
    } else {
      console.log(`    any sender`);
    }
    // The relayer config is the authoritative source for each chain's ICM registry
    // address. `avalanche blockchain describe` shows an ICM table whose addresses are
    // Fuji C-Chain's even while describing CSB (docs/fuji-ictt.md §1), so checking
    // those against CSB reports code: NONE for a registry that deployed perfectly
    // well somewhere else. Anything deploying a TokenHome or TokenRemote by hand
    // needs the right one, because it is a constructor argument.
    const reg = s["teleporter-registry-address"]
      ?? Object.values(s["message-contracts"] ?? {})
        .map((v) => v?.settings?.["teleporter-registry-address"]).find(Boolean);
    if (reg) console.log(`    ICM registry ${reg}`);

    // avalanche-cli always emits a zero-address entry for the off-chain-registry
    // message format alongside the real Teleporter messenger. It is standard and
    // means nothing is wrong — label it, because an unexplained 0x000…0 in a
    // routing table reads like a misconfiguration and invites a wild goose chase.
    for (const [c, v] of Object.entries(s["message-contracts"] ?? {})) {
      const fmt = v?.["message-format"];
      const note = /^0x0{40}$/i.test(c)
        ? "off-chain registry (normal — not a misconfiguration)"
        : (c.toLowerCase() === "0x253b2784c75e510dd0ff1da844684a1ac0aa5fcf"
            ? "Teleporter messenger" : (fmt ?? "custom"));
      console.log(`    messenger ${c}  ${note}`);
    }
  }

  // --- the APIs the relayer needs before it can relay anything -------------
  // Signature aggregation needs the source chain's validator set from the P-Chain,
  // and connections to enough of that stake. A message FROM CSB needs CSB's handful
  // of validators; a message FROM the C-Chain needs the PRIMARY NETWORK's, which is
  // thousands. So an unreachable or slow P-Chain API stops inbound traffic dead while
  // outbound keeps working — the same half-broken shape as a fee cap or a missing
  // allow-list entry, from a completely different cause.
  console.log(`APIS`);
  for (const which of ["p-chain-api", "info-api"]) {
    const url = cfg[which]?.["base-url"] ?? "(unset)";
    const isPublic = /api\.avax(-test)?\.network/.test(url);
    console.log(`  ${which.padEnd(12)} ${url}${isPublic
      ? "   <-- public endpoint: rate-limited and the usual cause of"
      : ""}`);
    if (isPublic) {
      console.log(`  ${" ".repeat(12)}      \"context deadline exceeded\" during aggregation`);
    }
  }
  console.log("");

  console.log(`\nDESTINATIONS — chains it delivers to (${dests.length})`);
  for (const dd of dests) {
    const id = dd["blockchain-id"];
    console.log(`  ${label(id)}`);
    const allowed = dd["allowed-destination-addresses"] ?? [];
    if (allowed.length) {
      console.log(`    ONLY delivers to:`);
      for (const a of allowed) console.log(`      ${safe(a)}`);
      warnings.push(`${KNOWN[id] ?? id} restricts destination addresses — a NEW remote `
        + `on this chain will NOT receive deliveries until it is added.`);
    } else {
      console.log(`    any destination`);
    }
    console.log(`    signing key: ${dd["account-private-key"] ? "present (not shown)" : "MISSING"}`);

    // THE FEE TRAP, and it is direction-specific, which is what makes it confusing.
    // The relayer submits transactions ON the destination chain. CSB's base fee floor
    // is 47,619 gwei; a relayer capped below that produces transactions the node
    // ACCEPTS and never mines. Messages then flow perfectly in the other direction --
    // where the relayer pays ordinary Fuji fees -- so the bridge looks half-broken in
    // a way that points at the contracts rather than at a fee cap.
    const maxBase = dd["max-base-fee"];
    const prio = dd["max-priority-fee-per-gas"];
    const isCSB = (KNOWN[id] ?? "") === "CSB";
    if (maxBase !== undefined || prio !== undefined) {
      console.log(`    max-base-fee: ${maxBase ?? "(unset)"}`
        + `   max-priority-fee-per-gas: ${prio ?? "(unset)"}`);
    }
    if (isCSB) {
      // ZERO MEANS UNSET, NOT "CAP AT ZERO". An earlier version of this check warned
      // on 0 and was wrong: the generated config uses 0 for BOTH destinations, and
      // deliveries to Fuji demonstrably work, which they could not if 0 were a hard
      // cap. Only a non-zero cap below the floor is a real problem.
      const floor = BigInt(process.env.CSB_MIN_BASE_FEE_WEI ?? 47_619_047_619_047n);
      if (maxBase !== undefined && BigInt(maxBase) > 0n && BigInt(maxBase) < floor) {
        warnings.push(`CSB's max-base-fee is ${maxBase}, BELOW the chain's ~47,619 gwei `
          + `floor (${floor}). Deliveries INTO CSB would be accepted and never mined, `
          + `while CSB -> Fuji kept working.`);
      } else {
        console.log(`    (max-base-fee ${maxBase === undefined || BigInt(maxBase) === 0n
          ? "unset — the relayer uses its own estimate, which must clear ~47,619 gwei"
          : "above the floor"})`);
      }
    }
  }

  // --- can the relayer actually transact on CSB? ---------------------------
  // The decisive question for deliveries INTO CSB, and invisible in the config
  // alone. The relayer submits transactions on the destination chain, so it needs
  // BOTH an allow-list entry and tRIEL for gas. Neither is needed for the other
  // direction, which is why CSB -> Fuji can work while Fuji -> CSB never has.
  //
  // The address is derived from the configured key. The key itself is never printed.
  const csbRpc = process.env.CSB_RPC_URL;
  const csbDest = dests.find((x) => (KNOWN[x["blockchain-id"]] ?? "") === "CSB");
  if (csbDest?.["account-private-key"]) {
    let addr = null;
    try {
      const k = csbDest["account-private-key"];
      addr = new ethers.Wallet(k.startsWith("0x") ? k : "0x" + k).address;
    } catch { /* unparseable key */ }
    console.log(`\nRELAYER ON CSB`);
    if (!addr) {
      console.log(`  could not derive the signing address from the configured key`);
    } else if (!csbRpc) {
      console.log(`  signing address ${addr}`);
      console.log(`  set CSB_RPC_URL (source ops/csb-env.sh) to check its gas and access`);
    } else {
      const p = new ethers.JsonRpcProvider(csbRpc);
      const [bal, role] = await Promise.all([
        p.getBalance(addr).catch(() => null),
        new ethers.Contract("0x0200000000000000000000000000000000000002",
          ["function readAllowList(address) view returns (uint256)"], p)
          .readAllowList(addr).then(Number).catch(() => null),
      ]);
      const NAMES = { 0: "none — CANNOT TRANSACT", 1: "enabled", 2: "admin", 3: "manager" };
      console.log(`  signing address ${addr}`);
      console.log(`  tRIEL balance   ${bal === null ? "unreadable" : ethers.formatEther(bal)}`);
      console.log(`  txAllowList     ${role === null ? "unreadable" : (NAMES[role] ?? role)}`);
      if (role === 0) {
        warnings.push(`The relayer cannot transact on CSB — it holds no txAllowList `
          + `entry. Deliveries INTO CSB are impossible; CSB -> Fuji is unaffected. Fix:`
          + `\n    CSB_DEV_ADDR=${addr} CSB_DEV_GAS=2000 CSB_DEV_DEPLOYER=0 \\`
          + `\n      npx hardhat run scripts/allow-dev.js --network csbRemote`);
      }
      if (bal !== null && bal === 0n) {
        warnings.push(`The relayer holds NO tRIEL on CSB, so it cannot pay for `
          + `deliveries into CSB even if allow-listed. Same command as above funds it.`);
      }
    }
  }

  // Both directions must exist or half the flow silently stalls: registration goes
  // one way, transfers the other.
  const srcIds = new Set(sources.map((s) => s["blockchain-id"]));
  const dstIds = new Set(dests.map((d) => d["blockchain-id"]));
  console.log(`\nROUTING`);
  for (const id of new Set([...srcIds, ...dstIds])) {
    const ok = srcIds.has(id) && dstIds.has(id);
    console.log(`  ${(KNOWN[id] ?? "unknown").padEnd(14)} `
      + `source:${srcIds.has(id) ? "yes" : "NO "}  destination:${dstIds.has(id) ? "yes" : "NO "}`
      + `${ok ? "" : "   <-- one-way only"}`);
    if (!ok) {
      warnings.push(`${KNOWN[id] ?? id} is configured in one direction only. `
        + `Registration and transfers travel opposite ways, so one of them will hang.`);
    }
  }

  console.log("");
  if (warnings.length) {
    console.log(`${"!".repeat(70)}`);
    for (const w of warnings) console.log(`  ${w}`);
    console.log(`${"!".repeat(70)}`);
    console.log(`\nEdit the config, then restart:`);
    console.log(`  avalanche interchain relayer stop && avalanche interchain relayer start`);
    process.exitCode = 1;
  } else {
    console.log(`No address restrictions and both chains are configured in both`);
    console.log(`directions. A second ICTT pair between these chains will be carried`);
    console.log(`without touching this config.`);
  }

  if ((cfg["log-level"] ?? "error") === "error") {
    console.log(`\nNote: log-level is "error", which hides delivery activity. To watch a`);
    console.log(`bridge transfer actually happen, set it to "debug" and restart.`);
  }
}

main().catch((e) => { console.error("\n" + (e.message ?? e)); process.exitCode = 1; });
