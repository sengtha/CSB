const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Read-only check that the money and fee policy is actually in force on the
 * live chain — not merely configured in a script somewhere.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/verify-policy.js --network csbRemote
 *
 * Sends no transactions and needs no key beyond what csb-env exports.
 *
 * Checks:
 *   1. Gas costs ~1 tRIEL for an ordinary payment
 *   2. A tokenized riel exists and is convertible from day 1
 *   3. Gas fees are routed to the public-good fund rather than burned
 *  (+) the configured script gas price still clears the fee floor
 */
const FEE_MANAGER = "0x0200000000000000000000000000000000000003";
const REWARD_MANAGER = "0x0200000000000000000000000000000000000004";
const REF_GAS = 21000n;
// Subnet-EVM's blackhole. When rewards are disabled, currentRewardAddress()
// reports THIS rather than the zero address — so "not zero" is not the same as
// "funding something", and checking only for zero reports burned fees as a pass.
const BLACKHOLE = "0x0100000000000000000000000000000000000000";

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const d = readDeployments();
  let failures = 0;
  const fail = (m) => { failures++; console.log(`   ✗ ${m}`); };
  const ok = (m) => console.log(`   ✓ ${m}`);

  console.log(`Chain ${(await provider.getNetwork()).chainId} · block ${await provider.getBlockNumber()}\n`);

  // --- 1. gas price ------------------------------------------------------
  console.log("1. Gas ~1 tRIEL per ordinary payment");
  const fm = new ethers.Contract(FEE_MANAGER, [
    "function getFeeConfig() view returns (uint256 gasLimit, uint256 targetBlockRate, uint256 minBaseFee, uint256 targetGas, uint256 baseFeeChangeDenominator, uint256 minBlockGasCost, uint256 maxBlockGasCost, uint256 blockGasCostStep)",
  ], provider);
  let cfg;
  try {
    cfg = await fm.getFeeConfig();
  } catch (_) {
    console.log("   ✗ feeManager precompile not readable — is this really the CSB chain?");
    console.log("     (source ops/csb-env.sh, and check CSB_RPC_URL points at the L1)");
    process.exitCode = 1;
    return;
  }
  const transferCost = cfg.minBaseFee * REF_GAS;
  console.log(`   fee floor ${ethers.formatUnits(cfg.minBaseFee, "gwei")} gwei`
    + ` → ${REF_GAS}-gas transfer costs ${ethers.formatEther(transferCost)} tRIEL`);
  // Anything within 10% of 1 tRIEL is "about 1 riel".
  const oneTriel = ethers.parseEther("1");
  const off = transferCost > oneTriel ? transferCost - oneTriel : oneTriel - transferCost;
  if (cfg.minBaseFee === 0n) fail("gas is FREE (minBaseFee 0) — the 1-riel policy is not applied");
  else if (off * 10n > oneTriel) fail(`a transfer costs ${ethers.formatEther(transferCost)} tRIEL, not ~1 — re-run set-gas-price.js`);
  else ok("an ordinary payment costs about 1 riel");

  // The base fee can sit above the floor; that is what users actually pay.
  const block = await provider.getBlock("latest");
  if (block?.baseFeePerGas != null && block.baseFeePerGas > cfg.minBaseFee) {
    const real = block.baseFeePerGas * REF_GAS;
    console.log(`   note: current base fee is ${ethers.formatUnits(block.baseFeePerGas, "gwei")} gwei`
      + ` (above the floor) → a transfer actually costs ${ethers.formatEther(real)} tRIEL`);
  }

  // --- 2. tokenized riel, day 1 -----------------------------------------
  console.log("\n2. A tokenized riel exists and converts from day 1");
  const khrAddr = d?.contracts?.KHRStablecoin;
  const convAddr = d?.contracts?.RielConverter;
  if (!khrAddr || !convAddr) {
    fail("KHRStablecoin / RielConverter missing from deployments.json");
  } else if ((await provider.getCode(convAddr)) === "0x") {
    fail(`no contract deployed at RielConverter ${convAddr}`);
  } else {
    const conv = new ethers.Contract(convAddr, [
      "function approved(address) view returns (bool)",
    ], provider);
    let isApproved = null;
    try { isApproved = await conv.approved(khrAddr); } catch (_) { /* older ABI */ }
    const sym = await symbolOf(ethers, provider, khrAddr);
    if (isApproved === true) ok(`${sym} (${khrAddr}) approved in the converter — wrap/unwrap live`);
    else if (isApproved === false) fail(`${sym} is NOT approved in the converter — nothing can convert`);
    else console.log(`   ? converter has no readable 'approved' view; ${sym} deployed at ${khrAddr}`);
  }

  // --- 3. fees fund public good -----------------------------------------
  console.log("\n3. Gas fees fund public good (not burned)");
  const rm = new ethers.Contract(REWARD_MANAGER, [
    "function currentRewardAddress() view returns (address)",
    "function areFeeRecipientsAllowed() view returns (bool)",
  ], provider);
  let reward = null;
  try { reward = await rm.currentRewardAddress(); } catch (_) {
    fail("RewardManager precompile unavailable — it can only be enabled at genesis");
  }
  if (reward !== null) {
    if (reward === ethers.ZeroAddress || reward.toLowerCase() === BLACKHOLE) {
      let allowed = false;
      try { allowed = await rm.areFeeRecipientsAllowed(); } catch (_) {}
      if (allowed) {
        fail("fees go to whichever validator produced the block, not the fund");
      } else {
        const burned = await provider.getBalance(BLACKHOLE);
        fail(`fees are BURNED — ${ethers.formatEther(burned)} tRIEL destroyed at the blackhole so far`);
        console.log("     fix: npx hardhat run scripts/set-reward-address.js --network csbRemote");
      }
    } else {
      const bal = await provider.getBalance(reward);
      ok(`fees route to ${reward}`);
      console.log(`   balance there: ${ethers.formatEther(bal)} tRIEL`);
      const charity = d?.pilot?.charity?.address;
      if (charity && charity.toLowerCase() !== reward.toLowerCase()) {
        console.log(`   note: this is NOT the charity in deployments.json (${charity})`);
      }
    }
  }

  // --- (+) script gas price still clears the floor -----------------------
  console.log("\n+  Script gas price clears the fee floor");
  const configured = BigInt(process.env.CSB_GAS_PRICE_WEI ?? "0");
  if (configured === 0n) {
    console.log("   ? CSB_GAS_PRICE_WEI not set — source ops/csb-env.sh before running scripts");
  } else if (configured <= cfg.minBaseFee) {
    fail(`CSB_GAS_PRICE_WEI ${ethers.formatUnits(configured, "gwei")} gwei is BELOW the`
      + ` ${ethers.formatUnits(cfg.minBaseFee, "gwei")} gwei floor — scripts will hang, looking like a stalled chain`);
    console.log(`     use CSB_GAS_PRICE_WEI=${(cfg.minBaseFee * 11n) / 10n}`);
  } else {
    ok(`${ethers.formatUnits(configured, "gwei")} gwei > ${ethers.formatUnits(cfg.minBaseFee, "gwei")} gwei floor`);
  }

  console.log(failures === 0
    ? "\nPolicy is in force."
    : `\n${failures} check(s) failed — see above.`);
  if (failures > 0) process.exitCode = 1;
}

async function symbolOf(ethers, provider, addr) {
  try {
    return await new ethers.Contract(addr, ["function symbol() view returns (string)"], provider).symbol();
  } catch (_) { return "token"; }
}

function readDeployments() {
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
