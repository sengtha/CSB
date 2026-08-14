const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { at } = require("./lib/aave");

/**
 * Retire the stand-in dollar.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/retire-usdx.js --network csbRemote
 *
 * USDx is Aave's MintableERC20: its mint() has no access control, so anybody can
 * create any amount. That made its supply arbitrary, the KHRt/USDx pool ratio a
 * number with nothing behind it, and — worst — it was accepted as Aave collateral
 * at 75% LTV, so anyone could mint a pile and borrow out the riel side.
 * docs/defi.md has carried that as an open finding since the market was built.
 *
 * CSB issues its own foreign currency now (docs/currency.md), so the stand-in has
 * nothing left to demonstrate that is not demonstrated better elsewhere.
 *
 * WHAT THIS CAN AND CANNOT DO. It cannot un-mint the token or close its mint():
 * that contract is immutable and nothing here changes it. What it CAN do is
 * withdraw the chain's endorsement of it:
 *
 *   1. set the Aave reserve's LTV, liquidation threshold and bonus to zero, so it
 *      is no longer collateral — the substantive fix, and the one docs/defi.md
 *      named as the honest middle option;
 *   2. freeze the reserve, which blocks new supplies and borrows while leaving
 *      repay and withdraw open, so nobody is trapped;
 *   3. mark it retired in deployments.json, which is what removes it from the
 *      lending page, the pool selector, the token list and the oracle page.
 *
 * IT REFUSES TO HIDE A MARKET PEOPLE ARE STILL IN. Step 3 is skipped if any aUSDx
 * or USDx debt is outstanding, because hiding a reserve from the only interface
 * anyone has is how a supplier loses track of a position. Steps 1 and 2 still run
 * — they are safe with holders present, and step 1 is the part that matters.
 * CSB_FORCE=1 overrides, and prints what it is overriding.
 *
 * Environment:
 *   CSB_BRIDGED_KEY=usdLocal   which `bridged` entry to retire (default usdLocal)
 *   CSB_FORCE=1                mark retired even with positions outstanding
 */

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

const bar = (s) => console.log(`\n${s}\n${"-".repeat(s.length)}`);

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const save = () => fs.writeFileSync(file, JSON.stringify(d, null, 2));
  const live = async (a) => a && (await provider.getCode(a)).length > 2;

  const key = process.env.CSB_BRIDGED_KEY ?? "usdLocal";
  const b = d.bridged?.[key];
  if (!b?.address) throw new Error(`No bridged.${key} in deployments.json.`);

  const token = new ethers.Contract(b.address, ERC20_ABI, provider);
  const symbol = await token.symbol().catch(() => b.symbol ?? key);
  const decimals = await token.decimals().then(Number).catch(() => b.decimals ?? 6);

  bar(`Retiring ${symbol} on chain ${(await provider.getNetwork()).chainId}`);
  console.log(`Deployer ${signer.address}`);
  console.log(`Token    ${b.address}  (${decimals} dp)`);
  console.log(`Supply   ${ethers.formatUnits(await token.totalSupply().catch(() => 0n), decimals)}`);
  console.log(`\nThe token itself is NOT changed. Its mint() stays open to anyone; nothing`);
  console.log(`on this chain can close it. What is withdrawn is the chain's endorsement.`);

  // --- 1 & 2: the Aave reserve ---------------------------------------------
  let outstanding = 0n, debt = 0n;
  const reserve = d.aave?.reserves?.[key];
  if (!reserve?.aToken || !(await live(d.aave?.poolConfigurator))) {
    bar("Aave");
    console.log(`  No live reserve for ${symbol} — nothing to reconfigure.`);
  } else {
    bar("Aave");
    const configurator = at("PoolConfigurator", d.aave.poolConfigurator, signer);
    outstanding = await new ethers.Contract(reserve.aToken, ERC20_ABI, provider)
      .totalSupply().catch(() => 0n);
    debt = await new ethers.Contract(reserve.variableDebtToken, ERC20_ABI, provider)
      .totalSupply().catch(() => 0n);
    console.log(`  a${symbol} outstanding  ${ethers.formatUnits(outstanding, decimals)}`);
    console.log(`  ${symbol} debt          ${ethers.formatUnits(debt, decimals)}`);

    /*
     * Zeroing the LTV is the substantive change: it removes the borrowing power
     * this token confers, which is the whole finding.
     *
     * FULL REMOVAL IS NOT ALWAYS AVAILABLE, and the reason is worth knowing before
     * it surfaces as a revert. PoolConfigurator refuses to set the liquidation
     * THRESHOLD to zero while the reserve has any suppliers — `_checkNoSuppliers`,
     * PoolConfigurator.sol:159 — because dropping the threshold under an open
     * position would make it instantly liquidatable through no act of the
     * borrower's. So with liquidity present the honest move is LTV 0 with the
     * threshold left where it is: no new borrowing power, existing positions not
     * detonated. Reaching zero on all three needs the suppliers out first.
     */
    const thr = Number(reserve.liquidationThreshold ?? 80) * 100;
    const bonus = Number(reserve.liquidationBonus ?? 105) * 100;
    if (outstanding === 0n) {
      await (await configurator.configureReserveAsCollateral(b.address, 0, 0, 0)).wait();
      console.log(`  LTV, liquidation threshold and bonus all set to 0 — fully removed as`);
      console.log(`  collateral. Possible because nobody has ${symbol} supplied.`);
    } else {
      await (await configurator.configureReserveAsCollateral(b.address, 0, thr, bonus)).wait();
      console.log(`  LTV set to 0 — ${symbol} confers no borrowing power from now on.`);
      console.log(`  Liquidation threshold LEFT at ${thr / 100}%: Aave refuses to zero it while`);
      console.log(`  ${ethers.formatUnits(outstanding, decimals)} a${symbol} is supplied, and`);
      console.log(`  zeroing it would liquidate open positions through no act of theirs.`);
      console.log(`  Once suppliers have withdrawn, re-run to finish the job.`);
      console.log(`  Anyone already borrowing against ${symbol} keeps that position but cannot`);
      console.log(`  extend it. Check who that is before walking away:`);
      console.log(`    npx hardhat run scripts/aave-diagnose.js --network csbRemote`);
    }

    await (await configurator.setReserveFreeze(b.address, true)).wait();
    console.log(`  reserve frozen — no new supplies or borrows; repay and withdraw stay open.`);
  }

  // --- 3: withdraw it from the interfaces ----------------------------------
  bar("Interfaces");
  const held = outstanding + debt;
  const force = process.env.CSB_FORCE === "1";
  if (held > 0n && !force) {
    console.log(`  NOT marked retired: ${ethers.formatUnits(held, decimals)} ${symbol} is still`);
    console.log(`  supplied or borrowed. Hiding the reserve now would leave those holders`);
    console.log(`  with no interface to act through, which is a worse outcome than a`);
    console.log(`  confusing menu entry.`);
    console.log(`\n  Withdraw and repay first, then re-run. Or CSB_FORCE=1 to accept it.`);
    console.log(`\n  The collateral change above HAS been applied — that was the part that`);
    console.log(`  mattered, and it does not depend on this step.`);
  } else {
    if (held > 0n) {
      console.log(`  CSB_FORCE=1: marking retired with ${ethers.formatUnits(held, decimals)} `
        + `${symbol} still outstanding. Those holders lose the UI path to their position;`);
      console.log(`  they can still call the Pool directly at ${d.aave.pool}.`);
    }
    d.bridged[key].retired = true;
    d.bridged[key].retiredNote = "Unlimited-mint stand-in. Superseded by CSB-issued "
      + "currency — see docs/currency.md. Contract untouched and still on chain.";
    if (d.aave?.reserves?.[key]) {
      d.aave.reserves[key].retired = true;
      d.aave.reserves[key].ltv = 0;
      d.aave.reserves[key].liquidationThreshold = 0;
      d.aave.reserves[key].liquidationBonus = 0;
    }
    if (d.usdMarket) d.usdMarket.retired = true;
    save();
    console.log(`  Marked retired in ${path.basename(file)}. It now disappears from`);
    console.log(`  /lend.html, /defi.html, /assets.html and the riel-dollar card on`);
    console.log(`  /oracle.html. Nothing was deleted — remove the flags to bring it back.`);
  }

  bar("Next");
  console.log(`Restart the app server for the interface changes to take effect.`);
  console.log(``);
  console.log(`Update docs/defi.md if this changes what its open finding says. The finding`);
  console.log(`was that an unlimited-mint token was collateral; after this it is that an`);
  console.log(`unlimited-mint token EXISTS, which is a smaller claim and still a true one.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
