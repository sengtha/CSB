const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { at } = require("./lib/aave");

/**
 * The thing a second reserve is FOR: post dollars, borrow riel, then move a price.
 *
 *   source ops/csb-env.sh
 *   CSB_BRIDGED_KEY=usdLocal npx hardhat run scripts/aave-cross-borrow.js --network csbRemote
 *
 * Environment, all optional:
 *   CSB_BRIDGED_KEY    which second asset to use              (default "usdLocal")
 *   CSB_COLLATERAL     units of it to post as collateral            (default 10)
 *   CSB_BORROW_KHR     whole riel to borrow against it           (default 20000)
 *   CSB_LP_KHR         whole riel of lending liquidity to supply  (default 50000)
 *   CSB_CRASH_TO       repriced value of the collateral, in riel   (default 1000)
 *   CSB_SKIP_CRASH=1   stop after borrowing, leave the price alone
 *
 * WHAT WAS IMPOSSIBLE BEFORE. With one reserve, "borrowing" meant depositing riel to
 * borrow riel — an operation that demonstrates the plumbing and nothing else — and
 * liquidation could only be provoked by EDITING THE LIQUIDATION THRESHOLD, which
 * proves that a config change has effects rather than that the market works. Two
 * reserves make both real: collateral in one asset, debt in another, and a health
 * factor that falls because a PRICE MOVED.
 *
 * IT NEEDS A LENDER. A borrow draws from supplied liquidity, and an empty reserve
 * does not report "insufficient liquidity" — it underflows in the rate maths and
 * reverts with `panic 0x11`, which names nothing useful. So this supplies the riel
 * side first, from the deployer, and says so rather than leaving a confusing revert
 * for somebody to diagnose later.
 *
 * THE CRASH IS REVERSIBLE AND THE SCRIPT RESTORES IT. Repricing the collateral is
 * how the demonstration works, but leaving a live lending market valuing an asset at
 * a quarter of its rate would be a trap for the next person. The original price is
 * put back at the end unless the run dies midway, in which case the restore command
 * is printed.
 */

const RAY = 10n ** 27n;
const PROVIDER_ABI = ["function getPriceOracle() view returns (address)"];
const ORACLE_ABI = [
  "function setAssetPrice(address,uint256)",
  "function getAssetPrice(address) view returns (uint256)",
];
const ERC20_ABI = [
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

const fmt18 = (v) => Number(hre.ethers.formatUnits(v, 18)).toLocaleString("en-US",
  { maximumFractionDigits: 2 });

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const key = process.env.CSB_BRIDGED_KEY ?? "usdLocal";
  const second = d.bridged?.[key];
  const a = d.aave;
  const khrAddr = d.contracts?.KHRStablecoin;
  if (!second?.address) throw new Error(`No bridged.${key} in deployments.json.`);
  if (!a?.pool) throw new Error("No aave.pool in deployments.json — run scripts/aave-live.js.");
  if (!a.reserves?.[key]) {
    throw new Error(`${key} is not listed as an Aave reserve. Run:\n`
      + `  CSB_BRIDGED_KEY=${key} npx hardhat run scripts/usdc-market.js --network csbRemote`);
  }

  const pool = at("Pool", a.pool, signer);
  const usd = new ethers.Contract(second.address, ERC20_ABI, signer);
  const khr = new ethers.Contract(khrAddr, ERC20_ABI, signer);
  const usdDec = Number(await usd.decimals());
  const khrDec = Number(await khr.decimals());
  const symbol = await usd.symbol().catch(() => key);

  const collateral = BigInt(process.env.CSB_COLLATERAL ?? 10) * 10n ** BigInt(usdDec);
  const borrow = BigInt(process.env.CSB_BORROW_KHR ?? 20_000) * 10n ** BigInt(khrDec);
  const lpKhr = BigInt(process.env.CSB_LP_KHR ?? 50_000) * 10n ** BigInt(khrDec);

  console.log(`Chain     ${(await provider.getNetwork()).chainId}`);
  console.log(`Borrower  ${signer.address}`);
  console.log(`Collateral ${ethers.formatUnits(collateral, usdDec)} ${symbol}`);
  console.log(`Borrowing  ${ethers.formatUnits(borrow, khrDec)} KHRt\n`);

  // --- 1. somebody has to be lending ---------------------------------------
  const khrBal = await khr.balanceOf(signer.address);
  if (khrBal < lpKhr + borrow) {
    throw new Error(`Deployer holds ${ethers.formatUnits(khrBal, khrDec)} KHRt but needs `
      + `${ethers.formatUnits(lpKhr, khrDec)} to supply as lending liquidity. Issue more, `
      + `or lower CSB_LP_KHR.`);
  }
  const reserveKhr = await new ethers.Contract(a.aToken, ERC20_ABI, provider)
    .balanceOf(a.aToken).catch(() => 0n);
  console.log(`[1] supplying ${ethers.formatUnits(lpKhr, khrDec)} KHRt of lending liquidity`);
  console.log(`    (an empty reserve makes borrow revert with panic 0x11, not a clear error)`);
  await (await khr.approve(a.pool, lpKhr)).wait();
  await (await pool.supply(khrAddr, lpKhr, signer.address, 0)).wait();

  // --- 2. post the OTHER asset as collateral -------------------------------
  console.log(`\n[2] supplying ${ethers.formatUnits(collateral, usdDec)} ${symbol} as collateral`);
  await (await usd.approve(a.pool, collateral)).wait();
  await (await pool.supply(second.address, collateral, signer.address, 0)).wait();

  let acct = await pool.getUserAccountData(signer.address);
  console.log(`    collateral base   ${fmt18(acct.totalCollateralBase)}`);
  console.log(`    available borrows ${fmt18(acct.availableBorrowsBase)}`);
  console.log(`    ltv               ${Number(acct.ltv) / 100}%`);

  // --- 3. borrow a DIFFERENT asset -----------------------------------------
  console.log(`\n[3] borrowing ${ethers.formatUnits(borrow, khrDec)} KHRt against ${symbol}`);
  const before = await khr.balanceOf(signer.address);
  await (await pool.borrow(khrAddr, borrow, 2, 0, signer.address)).wait();
  const after = await khr.balanceOf(signer.address);
  console.log(`    received ${ethers.formatUnits(after - before, khrDec)} KHRt`);

  acct = await pool.getUserAccountData(signer.address);
  const hfBefore = acct.healthFactor;
  console.log(`    debt base         ${fmt18(acct.totalDebtBase)}`);
  console.log(`    health factor     ${fmt18(hfBefore)}`);
  console.log(`\n    THIS IS THE PART ONE RESERVE COULD NOT DO: the collateral and the`);
  console.log(`    debt are different assets.`);

  if (process.env.CSB_SKIP_CRASH === "1") {
    console.log(`\nCSB_SKIP_CRASH=1 — leaving the price alone.`);
    return;
  }

  // --- 4. move the PRICE, not the config -----------------------------------
  const oracleAddr = await new ethers.Contract(a.addressesProvider, PROVIDER_ABI, provider)
    .getPriceOracle();
  const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, signer);
  const original = await oracle.getAssetPrice(second.address).catch(() => null);
  if (original === null) {
    console.log(`\n[4] SKIPPED — the live oracle does not expose setAssetPrice, so the price`);
    console.log(`    cannot be moved from here. It is the administered oracle; publish a`);
    console.log(`    lower rate with the publisher role instead.`);
    return;
  }

  const crashTo = BigInt(process.env.CSB_CRASH_TO ?? 1000) * 10n ** 18n;
  console.log(`\n[4] repricing ${symbol}: ${fmt18(original)} -> ${fmt18(crashTo)} riel`);
  console.log(`    A DEVALUATION, not a config change. The liquidation threshold is`);
  console.log(`    untouched at ${Number(acct.currentLiquidationThreshold) / 100}%.`);
  try {
    await (await oracle.setAssetPrice(second.address, crashTo)).wait();
    acct = await pool.getUserAccountData(signer.address);
    console.log(`    collateral base   ${fmt18(acct.totalCollateralBase)}`);
    console.log(`    health factor     ${fmt18(hfBefore)} -> ${fmt18(acct.healthFactor)}`);
    console.log(`    liquidatable      ${acct.healthFactor < 10n ** 18n}`);
    if (acct.healthFactor >= 10n ** 18n) {
      console.log(`\n    Still above 1.0 — the position is over-collateralised for this`);
      console.log(`    drop. Borrow more (CSB_BORROW_KHR) or crash further (CSB_CRASH_TO)`);
      console.log(`    to push it under.`);
    }
  } finally {
    // Leaving a live market valuing an asset at a quarter of its rate would be a
    // trap for whoever touches it next.
    console.log(`\n[5] restoring the price to ${fmt18(original)}`);
    try {
      await (await oracle.setAssetPrice(second.address, original)).wait();
      const back = await pool.getUserAccountData(signer.address);
      console.log(`    health factor back to ${fmt18(back.healthFactor)}`);
    } catch (e) {
      console.log(`    RESTORE FAILED (${e.shortMessage ?? e.message}). Do it by hand:`);
      console.log(`      oracle.setAssetPrice("${second.address}", "${original}")`);
    }
  }
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
