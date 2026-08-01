const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deploy the administered reference-rate oracle, and optionally point Aave at it.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/oracle-deploy.js --network csbRemote
 *
 * Environment, all optional:
 *   CSB_RATE_PUBLISHER  address that may publish rates (default: the deployer)
 *   CSB_MAX_AGE         seconds before a rate stops answering (default: 172800, 2 days)
 *   CSB_MAX_DEV_BPS     largest single move, basis points (default: 1000, 10%)
 *   CSB_WIRE_AAVE       set to "1" to repoint the live Aave market at this oracle
 *
 * WHAT THIS CHANGES, and why the Aave step is opt-in rather than automatic.
 *
 * The live lending market currently reads Aave's own test `PriceOracle`, whose price
 * was set by hand at deployment and never expires. Repointing the market at this
 * oracle makes two things true that were not true before:
 *
 *   - the price becomes an administered figure with a cited source, changeable only
 *     within a bound and only by the publishing role;
 *   - the market FAILS CLOSED. If nobody republishes within CSB_MAX_AGE, the oracle
 *     stops answering and every Aave read reverts — supply, borrow, withdraw,
 *     liquidate, and the health-factor display in the app. That is the right
 *     behaviour for a credit market on a rate nobody is standing behind, and it is
 *     also a way to halt the market by forgetting.
 *
 * So the wiring step requires CSB_WIRE_AAVE=1 deliberately. Deploying the oracle on
 * its own changes nothing.
 */

const PROVIDER_ABI = [
  "function setPriceOracle(address newPriceOracle)",
  "function getPriceOracle() view returns (address)",
  "function owner() view returns (address)",
];

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  const khr = d.contracts?.KHRStablecoin;
  if (!khr) throw new Error("KHRStablecoin missing from deployments.json");

  const publisher = process.env.CSB_RATE_PUBLISHER ?? signer.address;
  if (!ethers.isAddress(publisher)) {
    throw new Error(`CSB_RATE_PUBLISHER is not a valid address: ${JSON.stringify(publisher)}`);
  }
  const maxAge = BigInt(process.env.CSB_MAX_AGE ?? 172800);
  const maxDevBps = BigInt(process.env.CSB_MAX_DEV_BPS ?? 1000);

  console.log(`Chain    ${(await provider.getNetwork()).chainId}`);
  console.log(`Deployer ${signer.address}`);
  const before = await provider.getBalance(signer.address);

  if (d.oracle?.referenceRate && (await provider.getCode(d.oracle.referenceRate)).length > 2) {
    console.log(`\nAn oracle is already deployed: ${d.oracle.referenceRate}`);
    console.log("Delete the `oracle` block from deployments.json to deploy another.");
    return;
  }

  // The base currency unit must match what the live Aave market already uses, or
  // every existing position would be revalued by the change of scale rather than by
  // a change of rate. The deployed market prices KHRt at 1e18 per whole unit.
  const UNIT = 10n ** 18n;

  console.log(`\nDeploying ReferenceRateOracle`);
  console.log(`  council (bounds)   ${signer.address}`);
  console.log(`  publisher (rates)  ${publisher}${publisher === signer.address
    ? "   <-- SAME AS COUNCIL: the separation this contract is built for is not exercised" : ""}`);
  console.log(`  base currency      ${khr} (KHRt), unit 1e18`);
  console.log(`  max age            ${maxAge}s`);
  console.log(`  max deviation      ${maxDevBps} bps`);

  const oracle = await ethers.deployContract("ReferenceRateOracle", [
    signer.address, publisher, khr, UNIT, maxAge, maxDevBps,
  ]);
  await oracle.waitForDeployment();
  const oracleAddr = await oracle.getAddress();
  console.log(`\n  deployed at ${oracleAddr}`);

  // Publish an initial rate so the oracle answers. 1e18 reproduces exactly what the
  // live market reads today, so wiring it in does not revalue any position — the
  // change is in WHO may set the number and under what discipline, not in the number.
  const sourceRef = ethers.id(`initial-parity-${new Date().toISOString().slice(0, 10)}`);
  if (publisher === signer.address) {
    await (await oracle.publish(khr, UNIT, sourceRef)).wait();
    console.log(`  published initial rate 1e18, sourceRef ${sourceRef}`);
  } else {
    console.log(`\n  NOT publishing: the publisher is a different address. It must call`);
    console.log(`    oracle.publish("${khr}", "${UNIT}", <sourceRef>)`);
    console.log(`  before the oracle will answer.`);
  }

  d.oracle = {
    referenceRate: oracleAddr,
    baseCurrency: khr,
    baseCurrencyUnit: UNIT.toString(),
    publisher,
    maxAge: Number(maxAge),
    maxDeviationBps: Number(maxDevBps),
    note: "Administered rate, not a market price. Fails closed when stale: every "
      + "Aave read reverts if nobody republishes within maxAge. See docs/oracle.md.",
  };
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log(`  recorded in ${path.basename(file)}`);

  if (process.env.CSB_WIRE_AAVE === "1") {
    const addrProvider = d.aave?.addressesProvider;
    if (!addrProvider) {
      console.log(`\nCSB_WIRE_AAVE=1 but no aave.addressesProvider in deployments.json — skipped.`);
    } else {
      const p = new ethers.Contract(addrProvider, PROVIDER_ABI, signer);
      const owner = await p.owner().catch(() => null);
      if (owner && owner.toLowerCase() !== signer.address.toLowerCase()) {
        console.log(`\nCannot wire Aave: the addresses provider is owned by ${owner}.`);
      } else {
        const previous = await p.getPriceOracle();
        await (await p.setPriceOracle(oracleAddr)).wait();
        console.log(`\nAave repointed: ${previous} -> ${oracleAddr}`);
        console.log(`  The market now FAILS CLOSED. If no rate is published within`);
        console.log(`  ${maxAge}s every Aave read reverts. Revert with:`);
        console.log(`    addressesProvider.setPriceOracle("${previous}")`);
      }
    }
  } else {
    console.log(`\nAave NOT wired (set CSB_WIRE_AAVE=1 to do it). To wire it later:`);
    console.log(`  addressesProvider.setPriceOracle("${oracleAddr}")`);
  }

  const spent = before - (await provider.getBalance(signer.address));
  console.log(`\nCost: ${ethers.formatEther(spent)} tRIEL`);
  console.log(`\nKeep it fresh, or the market halts:`);
  console.log(`  oracle.publish(asset, price, sourceRef)   // publisher role`);
  console.log(`  oracle.describe(asset)                    // price, when, source, stale?`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
