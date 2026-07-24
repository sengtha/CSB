const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/**
 * Issue a scoped-RPC token for a KYC'd address. The user points their wallet
 * (MetaMask etc.) at https://<host>/rpc/<token> and gets a read-filtered view of
 * only their own data (see app/rpc-filter.js). No SSH tunnel needed; the node's
 * raw RPC still never faces the internet.
 *
 * Usage:
 *   node scripts/make-rpc-token.js <0xAddress> [label]
 *
 * Writes app/rpc-tokens.json (gitignored). The app server reads it per-request,
 * so a new token works without a restart.
 */
const [, , address, label] = process.argv;
if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error("Usage: node scripts/make-rpc-token.js <0xAddress> [label]");
  process.exit(1);
}

const file = process.env.CSB_RPC_TOKENS_FILE ?? path.join(__dirname, "..", "app", "rpc-tokens.json");
const map = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const token = crypto.randomBytes(24).toString("hex");
map[token] = { address, label: label ?? address };
fs.writeFileSync(file, JSON.stringify(map, null, 2));

console.log("Scoped RPC token issued:\n");
console.log(`  address: ${address}`);
console.log(`  label:   ${label ?? "(none)"}`);
console.log(`  token:   ${token}\n`);
console.log("MetaMask → Add network manually → New RPC URL (behind your HTTPS proxy):");
console.log(`  https://<your-elestio-host>/rpc/${token}\n`);
console.log("Give this URL only to that user — it grants read access to their scoped data,");
console.log("and lets them submit their own signed transactions (the chain still enforces KYC).");
