const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Fold elapsed time into the TWAP, and report what it now says.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/twap-update.js --network csbRemote
 *
 * Environment, both optional:
 *   CSB_TWAP    oracle address (default: oracle.twap from deployments.json)
 *   CSB_QUIET   set to "1" to print one line and nothing else
 *
 * WHY THIS HAS TO BE RUN AT ALL. A Uniswap V2 TWAP is not a feed. The pair
 * accumulates a time-weighted price on its own, but somebody must periodically read
 * that accumulator and divide, or there is no average to quote. `update()` is
 * permissionless by design — anyone can call it, which is the point of a trustless
 * price — but "anyone can" is not "someone does". On this chain that someone is a
 * cron entry or a person running this script.
 *
 * WHAT HAPPENS IF NOBODY DOES. Reads start reverting with `AverageStale` once the
 * last update is older than `maxAge` (a week, as deployed). That is the oracle
 * failing closed, and it is deliberate: a stale market price is worse than no price,
 * because it looks like an answer.
 *
 * SAFE TO RUN TOO OFTEN. A call inside `minWindow` reverts with `WindowTooShort` and
 * changes nothing but the gas. This script detects that case and reports it as a
 * no-op rather than an error, so it can sit in a cron entry without generating noise.
 *
 * READ-ONLY MODE. It never publishes, never wires anything, and touches no contract
 * other than the oracle. The worst outcome of a bad run is a wasted transaction fee.
 */

const ABI = [
  "function update()",
  "function describe() view returns (uint256 price, uint64 lastUpdate, bool stale, bool hasAverage)",
  "function timeSinceUpdate() view returns (uint256)",
  "function minWindow() view returns (uint256)",
  "function maxAge() view returns (uint256)",
  "function BASE_CURRENCY() view returns (address)",
  "function BASE_CURRENCY_UNIT() view returns (uint256)",
  "function quotedAsset() view returns (address)",
  "function pair() view returns (address)",
];

const ago = (seconds) => {
  const s = Number(seconds);
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${(s / 60).toFixed(0)}m ago`;
  if (s < 172800) return `${(s / 3600).toFixed(1)}h ago`;
  return `${(s / 86400).toFixed(1)}d ago`;
};

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();
  const quiet = process.env.CSB_QUIET === "1";
  const say = (...a) => { if (!quiet) console.log(...a); };

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  let recorded = null;
  try {
    recorded = JSON.parse(fs.readFileSync(file, "utf8")).oracle?.twap ?? null;
  } catch { /* the address may be supplied entirely by env */ }

  const addr = process.env.CSB_TWAP ?? recorded;
  if (!addr) {
    throw new Error("No TWAP address. Set CSB_TWAP, or run scripts/experiments-live.js "
      + "first so oracle.twap is recorded in deployments.json.");
  }
  if (!ethers.isAddress(addr)) {
    throw new Error(`CSB_TWAP is not a valid address: ${JSON.stringify(addr)}`);
  }
  if ((await provider.getCode(addr)).length <= 2) {
    throw new Error(`No contract at ${addr} on chain ${(await provider.getNetwork()).chainId}.`);
  }

  const oracle = new ethers.Contract(addr, ABI, signer);
  const [minWindow, maxAge, base, unit, quoted, pair] = await Promise.all([
    oracle.minWindow(), oracle.maxAge(), oracle.BASE_CURRENCY(),
    oracle.BASE_CURRENCY_UNIT(), oracle.quotedAsset(), oracle.pair(),
  ]);

  say(`Oracle   ${addr}`);
  say(`Pool     ${pair}`);
  say(`Pricing  ${quoted} in ${base}`);
  say(`Window   min ${minWindow}s, stale after ${maxAge}s\n`);

  const elapsed = await oracle.timeSinceUpdate();
  const [priceBefore, , staleBefore, hadAverage] = await oracle.describe();

  if (elapsed < minWindow) {
    // Not a failure. The oracle refuses windows this short on purpose, and calling
    // anyway would only burn gas on a revert.
    say(`Only ${elapsed}s since the accumulator was last folded in, and the minimum `
      + `window is ${minWindow}s.`);
    say(`Nothing to do — re-run in ${Number(minWindow) - Number(elapsed)}s.`);
    if (hadAverage) {
      console.log(`current: ${ethers.formatUnits(priceBefore, 18)} (unchanged`
        + `${staleBefore ? ", STALE" : ""})`);
    }
    return;
  }

  const before = await provider.getBalance(signer.address);
  const rc = await (await oracle.update()).wait();
  const spent = before - (await provider.getBalance(signer.address));

  const [price, lastUpdate, stale, hasAverage] = await oracle.describe();

  if (quiet) {
    console.log(`${ethers.formatUnits(price, 18)}  (${elapsed}s window, block ${rc.blockNumber})`);
    return;
  }

  console.log(`Updated in block ${rc.blockNumber} — ${elapsed}s window, `
    + `${ethers.formatEther(spent)} tRIEL`);
  console.log(`\n  price     ${ethers.formatUnits(price, 18)} per whole quoted token`);
  if (hadAverage) {
    const move = priceBefore === 0n ? null
      : Number(((price - priceBefore) * 10_000n) / priceBefore) / 100;
    console.log(`  previous  ${ethers.formatUnits(priceBefore, 18)}`
      + (move === null ? "" : `   (${move >= 0 ? "+" : ""}${move.toFixed(2)}%)`));
  } else {
    console.log(`  previous  none — this is the first average this oracle has had`);
  }
  console.log(`  updated   ${new Date(Number(lastUpdate) * 1000).toISOString()}`);
  console.log(`  fresh     ${hasAverage && !stale ? "yes" : "NO"}`);

  console.log(`\n  This is a market rate over the last ${elapsed}s, not a quote and not`);
  console.log(`  an official rate. The pool behind it is small — see docs/oracle.md`);
  console.log(`  before treating this number as a valuation.`);
  console.log(`\n  Re-run within ${maxAge}s or reads start reverting.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
