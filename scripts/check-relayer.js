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

function main() {
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

try { main(); } catch (e) { console.error("\n" + (e.message ?? e)); process.exitCode = 1; }
