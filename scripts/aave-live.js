const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { deployAaveMarket } = require("./lib/aave");

/**
 * Deploy a real Aave V3 lending market on the live CSB chain, for people to use.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/aave-live.js --network csbRemote
 *
 * This is the live counterpart to test/defi-aave.test.js. Same published
 * @aave/core-v3 bytecode, unrecompiled — around twenty deployments, because Pool
 * exceeds the contract size limit on its own and its logic lives in eight
 * external libraries that must be linked first.
 *
 * WHAT IT COSTS. Expect roughly 1,500-2,500 tRIEL at the 1-riel fee policy. Every
 * step's real cost is printed, because that figure is data: nobody has published
 * what standing up a lending market costs on a chain that prices gas as fiscal
 * policy.
 *
 * WHAT IT CHANGES ON A LIVE CHAIN, and why you should think before running it:
 *
 *   - It marks the Pool and the aToken as KHRt SYSTEM CONTRACTS. That is a real
 *     privilege: it lets them custody KHRt without holding a KYC attestation.
 *     Both addresses are printed so the council can revoke them later.
 *   - The oracle is Aave's own test PriceOracle with a hand-set price. There are
 *     no price feeds on CSB, so there is no honest alternative — but it means
 *     this market's valuations are whatever the deployer says they are. It is a
 *     demonstration, not a place to put money that matters.
 *   - Anyone KYC'd can then supply and borrow. On a testnet that is the point.
 *
 * Idempotent: if deployments.json already carries an `aave` block with a pool
 * that has code, it reports and exits rather than deploying a second market.
 */
async function main() {
  const { ethers } = hre;
  const [signer] = await ethers.getSigners();
  const provider = ethers.provider;
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const khrAddr = d.contracts?.KHRStablecoin;
  if (!khrAddr) throw new Error("KHRStablecoin missing from deployments.json");

  console.log(`Chain    ${(await provider.getNetwork()).chainId}`);
  console.log(`Deployer ${signer.address}`);
  const before = await provider.getBalance(signer.address);
  console.log(`Balance  ${ethers.formatEther(before)} tRIEL`);
  const blk = await provider.getBlock("latest");
  console.log(`Base fee ${ethers.formatUnits(blk?.baseFeePerGas ?? 0n, "gwei")} gwei\n`);

  if (d.aave?.pool && (await provider.getCode(d.aave.pool)).length > 2) {
    console.log("An Aave market is already deployed on this chain:");
    for (const [k, v] of Object.entries(d.aave)) console.log(`  ${k.padEnd(14)} ${v}`);
    console.log("\nDelete the `aave` block from deployments.json to deploy a second one.");
    return;
  }

  const khr = new ethers.Contract(khrAddr, [
    "function decimals() view returns (uint8)",
    "function setSystemContract(address,bool)",
    "function isSystemContract(address) view returns (bool)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  ], signer);

  if (!(await khr.hasRole(await khr.DEFAULT_ADMIN_ROLE(), signer.address))) {
    throw new Error("Signer lacks KHRt DEFAULT_ADMIN_ROLE — it could deploy the market "
      + "but not let the pool custody KHRt, which would leave it unusable.");
  }

  const decimals = Number(await khr.decimals());
  console.log(`Listing KHRt (${khrAddr}, ${decimals} decimals) as the reserve.`);
  console.log("Deploying ~20 contracts. This takes a few minutes.\n");

  const market = await deployAaveMarket(signer, khrAddr, decimals);

  const poolAddr = await market.pool.getAddress();
  const aTokenAddr = await market.aToken.getAddress();

  // Both custody KHRt, and neither can hold a KYC attestation — they are
  // contracts. Without this the first supply() reverts on compliance.
  for (const [label, addr] of [["Pool", poolAddr], ["aToken", aTokenAddr]]) {
    if (await khr.isSystemContract(addr)) {
      console.log(`${label} already vetted as a system contract`);
    } else {
      await (await khr.setSystemContract(addr, true)).wait();
      console.log(`${label} vetted as a KHRt system contract — ${addr}`);
    }
  }

  d.aave = {
    pool: poolAddr,
    poolConfigurator: await market.configurator.getAddress(),
    addressesProvider: await market.provider.getAddress(),
    aclManager: await market.acl.getAddress(),
    oracle: await market.oracle.getAddress(),
    aToken: aTokenAddr,
    variableDebtToken: await market.variableDebt.getAddress(),
    stableDebtToken: await market.stableDebt.getAddress(),
    underlying: khrAddr,
    decimals,
    note: "Unmodified @aave/core-v3 1.19.3. Test oracle with a hand-set price — "
      + "valuations are not market-derived. See docs/paper §5.4.",
  };
  fs.writeFileSync(file, JSON.stringify(d, null, 2));

  const after = await provider.getBalance(signer.address);
  const spent = before - after;

  console.log(`\n${"=".repeat(66)}`);
  for (const [k, v] of Object.entries(d.aave)) {
    if (k !== "note") console.log(`  ${k.padEnd(18)} ${v}`);
  }
  console.log(`\n  Total cost: ${ethers.formatEther(spent)} tRIEL`);
  console.log(`  Recorded in ${path.basename(file)} — the lending page will find it.`);
  console.log(`\n  To revoke the market's KHRt privileges later:`);
  console.log(`    khr.setSystemContract("${poolAddr}", false)`);
  console.log(`    khr.setSystemContract("${aTokenAddr}", false)`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
