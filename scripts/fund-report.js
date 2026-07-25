const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * What the public-good fund has raised, across both streams.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/fund-report.js --network csbRemote
 *
 * Read-only. The two streams are deliberately different in reach, and the split
 * is the interesting part of the demo:
 *
 *   gas fees   — every transaction on the chain, handed over by the chain
 *                itself at block production. Nothing is asked of the sender and
 *                no contract is involved, so it cannot be opted out of.
 *   levy       — a flat amount per KHRt payment, enforced by contract code.
 *                Targeted and exemptible, and the one a user actually sees.
 *
 * ILLUSTRATIVE: the recipient is a placeholder account holding valueless test
 * tokens. No affiliation with any real organisation is implied.
 */
const REWARD_MANAGER = "0x0200000000000000000000000000000000000004";

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const d = readDeployments();

  const rm = new ethers.Contract(REWARD_MANAGER,
    ["function currentRewardAddress() view returns (address)"], provider);

  let fund = process.env.CSB_FUND_ADDR ?? null;
  if (!fund) {
    try { fund = await rm.currentRewardAddress(); } catch (_) {}
    if (!fund || fund === ethers.ZeroAddress) fund = d?.pilot?.charity?.address ?? null;
  }
  if (!fund) throw new Error("No fund address — set CSB_FUND_ADDR.");

  const label = d?.pilot?.charity?.label ?? "public-good fund";
  console.log(`Public-good fund — ${label}`);
  console.log(`${fund}\n`);

  // --- stream 1: gas fees (native tRIEL) ---------------------------------
  const gas = await provider.getBalance(fund);
  let routed = false;
  try { routed = (await rm.currentRewardAddress()).toLowerCase() === fund.toLowerCase(); } catch (_) {}
  console.log(`  Gas fees (tRIEL)      ${fmt(ethers, gas).padStart(16)}  ${routed ? "← live, every transaction" : "⚠ NOT currently routed here"}`);

  // --- stream 2: transfer levy (KHRt) ------------------------------------
  let levyTotal = 0n, decimals = 2n, sym = "KHRt", perTransfer = null, held = 0n;
  const khrAddr = d?.contracts?.KHRStablecoin;
  if (khrAddr) {
    const khr = new ethers.Contract(khrAddr, [
      "function totalLevied() view returns (uint256)",
      "function transferLevy() view returns (uint256)",
      "function levyRecipient() view returns (address)",
      "function balanceOf(address) view returns (uint256)",
      "function decimals() view returns (uint8)",
      "function symbol() view returns (string)",
    ], provider);
    try {
      [levyTotal, perTransfer, decimals, sym, held] = await Promise.all([
        khr.totalLevied(), khr.transferLevy(), khr.decimals(), khr.symbol(), khr.balanceOf(fund),
      ]);
      decimals = BigInt(decimals);
      const recip = await khr.levyRecipient();
      const on = perTransfer > 0n && recip.toLowerCase() === fund.toLowerCase();
      console.log(`  Transfer levy (${sym})  ${units(levyTotal, decimals).padStart(16)}  ${on ? `← ${units(perTransfer, decimals)} per ${sym} payment` : "⚠ levy off or pointed elsewhere"}`);
      if (held !== levyTotal) {
        console.log(`  ${sym} balance held      ${units(held, decimals).padStart(16)}  (differs from levied — the fund has spent or received ${sym} directly)`);
      }
    } catch (_) {
      console.log(`  Transfer levy         (KHRt at ${khrAddr} has no levy interface)`);
    }
  }

  // --- combined, in riel -------------------------------------------------
  // 1 tRIEL = 1 riel and 1 KHRt = 1 riel, which is the whole point of the
  // two-tier model: both streams are denominated in the same unit.
  const rielFromGas = Number(ethers.formatEther(gas));
  const rielFromLevy = Number(units(levyTotal, decimals).replace(/,/g, ""));
  console.log(`  ${"".padEnd(22)}${"".padStart(16, "─")}`);
  console.log(`  Total raised          ${(rielFromGas + rielFromLevy).toLocaleString(undefined, { maximumFractionDigits: 2 }).padStart(16)} riel`);

  console.log(`\nBoth streams are denominated in riel, so they add up directly:`);
  console.log(`1 tRIEL = 1 riel = 1 ${sym}. Gas fees reach every transaction on the`);
  console.log(`chain; the levy reaches ${sym} payments and is the part a user sees.`);
  console.log(`\nIllustrative demo on a testnet — valueless test tokens, no real organisation involved.`);
}

function fmt(ethers, wei) {
  return Number(ethers.formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function units(v, decimals) {
  const base = 10n ** decimals;
  const whole = v / base, frac = v % base;
  const fracStr = decimals > 0n ? "." + frac.toString().padStart(Number(decimals), "0") : "";
  return whole.toLocaleString() + fracStr;
}

function readDeployments() {
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
