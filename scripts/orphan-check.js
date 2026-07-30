const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Assess an ORPHANED deployment: a gated token still live on chain but wired to an
 * IdentityRegistry that is no longer the chain's active one. Read-only.
 *
 *   source ops/csb-env.sh
 *   CSB_TOKEN=0x<orphaned token> npx hardhat run scripts/orphan-check.js --network csbRemote
 *
 * WHY THIS EXISTS. `scripts/audit-allowlist.js` found addresses transacting
 * successfully on tokens with symbols KHRt and LAND1 that hold no attestation in the
 * chain's current registry. They are attested in an EARLIER registry, which those
 * tokens still trust, because the reference is immutable:
 *
 *     IdentityRegistry public immutable identity;     // KHRStablecoin.sol
 *
 * So redeploying the suite does not replace the compliance perimeter — it FORKS it.
 * The old assets keep working under governance nobody is administering, and the
 * current Identity Authority cannot revoke, freeze or confiscate against them
 * because it holds no role on the registry they obey.
 *
 * This reports the two things that decide what to do about it: how much value is
 * exposed, and whether anyone still holds the roles needed to neutralise it.
 */

const ERC20 = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function identity() view returns (address)",
  "function enforcement() view returns (address)",
  "function paused() view returns (bool)",
  "function hasRole(bytes32,address) view returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const ROLES = [
  ["DEFAULT_ADMIN_ROLE", "0x" + "0".repeat(64)],
  ["ISSUER_ROLE", null], ["ENFORCER_ROLE", null],
  ["AGENT_ROLE", null], ["REGISTRAR_ROLE", null],
];

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const tokenAddr = process.env.CSB_TOKEN;
  if (!ethers.isAddress(tokenAddr ?? "")) {
    throw new Error(`CSB_TOKEN must be a full 42-character address, got: ${JSON.stringify(tokenAddr)}\n`
      + `  Get candidates from: npx hardhat run scripts/audit-allowlist.js --network csbRemote`);
  }
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const currentReg = d.contracts?.IdentityRegistry;

  const t = new ethers.Contract(tokenAddr, ERC20, provider);
  const [sym, dec, supply] = await Promise.all([
    t.symbol().catch(() => "?"), t.decimals().catch(() => 18), t.totalSupply().catch(() => 0n),
  ]);
  const f = (v) => Number(ethers.formatUnits(v, dec))
    .toLocaleString("en-US", { minimumFractionDigits: 2 });

  console.log(`\nORPHAN CHECK — ${tokenAddr}`);
  console.log(`  symbol ${sym}   decimals ${dec}`);
  console.log(`  total supply ${f(supply)}`);
  try { console.log(`  paused: ${await t.paused()}`); } catch { console.log(`  paused: (no pause)`); }

  const reg = await t.identity().catch(() => null);
  console.log(`\nWHICH REGISTRY IT OBEYS`);
  console.log(`  this token trusts   ${reg ?? "(no identity getter)"}`);
  console.log(`  the chain's current ${currentReg ?? "(not in deployments.json)"}`);
  const orphaned = reg && currentReg
    && ethers.getAddress(reg) !== ethers.getAddress(currentReg);
  console.log(`  => ${orphaned ? "ORPHANED — a different registry" : "wired to the current registry"}`);
  if (!orphaned) {
    console.log(`\n  Not an orphan. Nothing further to report.`);
    return;
  }

  // Who can still act? Without a role on the OLD registry and the OLD token, the
  // orphan cannot be neutralised at all, which is the worst case and the one worth
  // knowing before promising a remediation.
  const [signer] = await ethers.getSigners().catch(() => [null]);
  const candidates = [];
  if (signer?.address) candidates.push(["the configured signer", signer.address]);
  for (const [k, v] of Object.entries(d.contracts ?? {})) {
    if (typeof v === "string" && ethers.isAddress(v)) candidates.push([`contracts.${k}`, v]);
  }

  console.log(`\nWHO CAN STILL ACT ON IT`);
  const oldReg = new ethers.Contract(reg, ERC20, provider);
  for (const [label, addr] of candidates.slice(0, 6)) {
    const held = [];
    for (const [rn, fixed] of ROLES) {
      const rid = fixed ?? ethers.id(rn);
      for (const [what, c] of [["token", t], ["old registry", oldReg]]) {
        try { if (await c.hasRole(rid, addr)) held.push(`${rn} on the ${what}`); }
        catch { /* not AccessControl */ }
      }
    }
    if (held.length) console.log(`  ${label} ${addr}\n    ${held.join("\n    ")}`);
  }

  // Where the value sits, so the exposure is a number rather than a worry.
  console.log(`\nWHERE THE SUPPLY SITS`);
  try {
    const logs = await t.queryFilter(t.filters.Transfer(), 0, await provider.getBlockNumber());
    const seen = new Set();
    for (const l of logs) for (const a of [l.args.from, l.args.to]) {
      if (a && a !== ethers.ZeroAddress) seen.add(ethers.getAddress(a));
    }
    let counted = 0n;
    for (const a of seen) {
      const b = await t.balanceOf(a);
      if (b === 0n) continue;
      counted += b;
      // Status in the OLD registry — the only one this token consults.
      let st = "?";
      try {
        const r = new ethers.Contract(reg,
          ["function isActive(address) view returns (bool)"], provider);
        st = (await r.isActive(a)) ? "active in the OLD registry" : "not active even there";
      } catch { /* ignore */ }
      console.log(`  ${a}  ${f(b)} ${sym}  (${st})`);
    }
    console.log(`  accounted for: ${f(counted)} of ${f(supply)}`);
  } catch (e) {
    console.log(`  (could not scan Transfer logs: ${e.shortMessage ?? e.message})`);
  }

  console.log(`\nWHAT TO DO`);
  console.log(`  This asset cannot be brought under the current registry — the`);
  console.log(`  reference is immutable. The options are to neutralise it or to`);
  console.log(`  accept and document it:`);
  console.log(`    1. If a held role above allows it, pause the token, or revoke every`);
  console.log(`       attestation in the OLD registry so transfers start reverting.`);
  console.log(`    2. If no role is held, it cannot be stopped. Say so plainly in the`);
  console.log(`       deployment record rather than implying the perimeter covers it.`);
  console.log(`  Either way, record it in docs/deployment-status.md, and see`);
  console.log(`  docs/architecture.md on why a redeploy forks the perimeter.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
