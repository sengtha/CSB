const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Does an aToken claim on pooled KHRt escape the compliance perimeter, or not?
 *
 *   source ops/csb-env.sh
 *   CSB_FROM=0x<holder> CSB_TO=0x<recipient> \
 *     npx hardhat run scripts/atoken-escape-test.js --network csbRemote
 *
 * This is the live version of `finding 3` in docs/defi.md, which until now was a
 * local result. It exists because a live transfer of aKHRt to an unattested
 * address was reported as failing, which — if true — contradicts the local test
 * and would mean the finding is wrong on the real chain. That has to be settled
 * from the chain, not from argument.
 *
 * HOW IT AVOIDS GUESSING. It simulates both transfers with eth_call and a `from`
 * override, so:
 *   - no private key is needed, for any account;
 *   - nothing is signed and no state changes;
 *   - a revert comes back as data that can be decoded, instead of as a wallet
 *     popup saying "transaction may fail".
 *
 * The two simulations are the whole experiment, run side by side:
 *   1. KHRt.transfer(to)   — the regulated ASSET. Expected to REVERT for an
 *                            unattested recipient. This is the perimeter working.
 *   2. aKHRt.transfer(to)  — the RECEIPT. If this succeeds, economic exposure to
 *                            pooled regulated money reaches an address that
 *                            cannot hold a single riel of the asset itself.
 *
 * A caution about interpreting failure (2): Aave checks the SENDER's health
 * factor on transfer, so a holder carrying debt can be refused for reasons that
 * have nothing to do with compliance. That refusal is code 35, and this script
 * names it, because reading it as a compliance block would be exactly the wrong
 * conclusion. To test the finding cleanly, send from a holder with no debt.
 */

const AAVE_ERRORS = {
  "34": "COLLATERAL_BALANCE_IS_ZERO",
  "35": "HEALTH_FACTOR_LOWER_THAN_LIQUIDATION_THRESHOLD — the SENDER's own debt "
      + "blocks this, NOT compliance. Retry from a holder with no debt.",
  "36": "COLLATERAL_CANNOT_COVER_NEW_BORROW",
};

const ERC20 = [
  "function transfer(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
const IDENTITY = [
  "function isActive(address) view returns (bool)",
  "function tierOf(address) view returns (uint8)",
];
const TX_ALLOW_LIST = "0x0200000000000000000000000000000000000002";
const ROLE_NAMES = { 0: "none", 1: "enabled", 2: "admin", 3: "manager" };

/** Pull something human-readable out of whatever the node returned. */
function decodeRevert(ethers, e) {
  const raw = e?.shortMessage ?? e?.message ?? String(e);
  // Aave reverts with a bare numeric string; a standalone 1-2 digit group only.
  const num = raw.match(/reverted(?:\s+with\s+reason\s+string)?:?\s*["']?(\d{1,2})["']?/);
  if (num) {
    const code = num[1];
    return `Aave code ${code}${AAVE_ERRORS[code] ? ` — ${AAVE_ERRORS[code]}` : ""}`;
  }
  // A named custom error (KHRt's compliance gate uses these).
  const custom = e?.revert?.name ?? raw.match(/custom error '([^']+)'/)?.[1];
  if (custom) return `custom error ${custom}`;
  const str = raw.match(/reverted with reason string ['"]([^'"]+)['"]/);
  if (str) return `revert string "${str[1]}"`;
  return raw;
}

async function complianceOf(ethers, provider, addr, identityAddr) {
  const bits = [];
  if (identityAddr && ethers.isAddress(identityAddr)) {
    try {
      const reg = new ethers.Contract(identityAddr, IDENTITY, provider);
      const [active, tier] = await Promise.all([reg.isActive(addr), reg.tierOf(addr)]);
      bits.push(active ? `KYC active (tier ${tier})` : "NO KYC ATTESTATION");
    } catch { /* unreadable — say nothing rather than guess */ }
  }
  try {
    const al = new ethers.Contract(TX_ALLOW_LIST,
      ["function readAllowList(address) view returns (uint256)"], provider);
    const n = Number(await al.readAllowList(addr));
    bits.push(`txAllowList: ${ROLE_NAMES[n] ?? n}`);
  } catch { /* precompile absent */ }
  return bits.length ? bits.join(", ") : "(registries unreadable)";
}

/** Simulate `token.transfer(to, amount)` as `from`, without signing anything. */
async function trySend(ethers, provider, token, from, to, amount, label) {
  const iface = new ethers.Interface(ERC20);
  const data = iface.encodeFunctionData("transfer", [to, amount]);
  try {
    await provider.call({ from, to: token, data });
    console.log(`  ${label.padEnd(34)} WOULD SUCCEED`);
    return true;
  } catch (e) {
    console.log(`  ${label.padEnd(34)} WOULD REVERT`);
    console.log(`  ${" ".repeat(34)}   ${decodeRevert(ethers, e)}`);
    return false;
  }
}

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const a = d.aave;
  if (!a?.aToken) throw new Error("No aave.aToken in deployments.json — no market here.");

  const from = process.env.CSB_FROM;
  const to = process.env.CSB_TO;
  for (const [name, v] of [["CSB_FROM", from], ["CSB_TO", to]]) {
    if (!ethers.isAddress(v ?? "")) {
      throw new Error(`${name} must be a full 42-character address, got: ${JSON.stringify(v)}\n`
        + `  CSB_FROM = an address that HOLDS aKHRt (ideally with no debt)\n`
        + `  CSB_TO   = the recipient to test, e.g. one with no KYC attestation`);
    }
  }

  const aToken = new ethers.Contract(a.aToken, ERC20, provider);
  const under = new ethers.Contract(a.underlying, ERC20, provider);
  const dec = Number(a.decimals ?? (await under.decimals()));
  const f = (v) => Number(ethers.formatUnits(v, dec))
    .toLocaleString("en-US", { minimumFractionDigits: 2 });

  const [aFrom, uFrom, aTo, uTo] = await Promise.all([
    aToken.balanceOf(from), under.balanceOf(from),
    aToken.balanceOf(to), under.balanceOf(to),
  ]);

  console.log(`\nChain ${(await provider.getNetwork()).chainId}`);
  console.log(`\nSENDER   ${from}`);
  console.log(`  ${await complianceOf(ethers, provider, from, d.contracts?.IdentityRegistry)}`);
  console.log(`  holds ${f(aFrom)} aKHRt, ${f(uFrom)} KHRt`);
  console.log(`\nRECIPIENT ${to}`);
  console.log(`  ${await complianceOf(ethers, provider, to, d.contracts?.IdentityRegistry)}`);
  console.log(`  holds ${f(aTo)} aKHRt, ${f(uTo)} KHRt`);

  if (aFrom === 0n) {
    console.log(`\nThe sender holds no aKHRt, so this proves nothing. Pick a holder`);
    console.log(`from: npx hardhat run scripts/aave-diagnose.js --network csbRemote`);
    return;
  }

  // Default to one unit at the token's own scale. Deliberately tiny: a
  // health-factor refusal on 1.00 means the sender is genuinely at its limit
  // rather than that we asked for too much, so a refusal here is informative.
  // Override with CSB_AMOUNT to reproduce a specific failed transfer — moving a
  // large fraction of an indebted holder's collateral WILL hit code 35, and that
  // is a debt limit, not a compliance block.
  const amount = process.env.CSB_AMOUNT
    ? ethers.parseUnits(String(process.env.CSB_AMOUNT).replaceAll(",", ""), dec)
    : BigInt(10) ** BigInt(dec);
  console.log(`\nSIMULATING a transfer of ${f(amount)} to the recipient (eth_call, nothing signed):`);
  const assetOk = await trySend(ethers, provider, a.underlying, from, to, amount,
    "KHRt (the regulated ASSET)");
  const receiptOk = await trySend(ethers, provider, a.aToken, from, to, amount,
    "aKHRt (the RECEIPT)");

  console.log(`\nVERDICT`);
  if (!assetOk && receiptOk) {
    console.log(`  FINDING CONFIRMED, LIVE. The asset cannot reach this recipient,`);
    console.log(`  but the claim on the pooled asset can. The perimeter governs`);
    console.log(`  custody; composability governs exposure.`);
  } else if (!assetOk && !receiptOk) {
    console.log(`  Both refused. Read the aKHRt reason above before concluding`);
    console.log(`  anything: if it is Aave code 35 the SENDER's debt caused it and`);
    console.log(`  this says nothing about compliance — retry from a debt-free`);
    console.log(`  holder. Any other reason means the receipt is genuinely gated`);
    console.log(`  on this chain, and docs/defi.md finding 3 needs correcting.`);
  } else if (assetOk) {
    console.log(`  The recipient can receive the ASSET itself, so it is inside the`);
    console.log(`  perimeter and cannot demonstrate an escape. Pick a recipient with`);
    console.log(`  no KYC attestation.`);
  }
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
