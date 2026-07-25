const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { enableTransactor, enableDeployer, explain } = require("./lib/csb-precompiles");

/**
 * Land title — tokenize a parcel (ERC-3643), sell a share, borrow against it.
 *
 * Shows the three claims in order: only the registrar can issue a title, the
 * token refuses to settle with anyone the identity layer has not verified, and
 * an unrelated lending contract can take the result as collateral.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/demo-land.js --network csbRemote
 *
 * ILLUSTRATIVE. No real cadastre, parcel, or title is represented. Tokens minted
 * here convey no rights over any property whatsoever.
 */
async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();

  const identity = await ethers.getContractAt("IdentityRegistry", d.contracts.IdentityRegistry);
  const khr = await ethers.getContractAt("KHRStablecoin", d.contracts.KHRStablecoin);

  console.log(`Registrar / lender (pilot: all one key): ${deployer.address}\n`);

  // The deployer stands in for the lender here, and a lender holds KHRt — which
  // means it needs its own KYC attestation like anyone else. Being the chain's
  // admin grants no exemption from the token's own rules, so register it if the
  // registry has not seen it before.
  if (!(await identity.isActive(deployer.address))) {
    await (await identity.register(deployer.address, ethers.id("land-lender-institution"), 4)).wait();
    console.log("Registered the lender institution (tier 4) — admin rights are not a KYC exemption.\n");
  }

  // --- 1. registry + vault ------------------------------------------------
  let registry, vault;
  if (d.contracts.LandTitleRegistry) {
    registry = await ethers.getContractAt("LandTitleRegistry", d.contracts.LandTitleRegistry);
    console.log(`Using existing LandTitleRegistry ${registry.target}`);
  } else {
    console.log("Deploying LandTitleRegistry…");
    registry = await ethers.deployContract("LandTitleRegistry", [
      d.contracts.IdentityRegistry, d.contracts.EnforcementRegistry, deployer.address, deployer.address,
    ]);
    await registry.waitForDeployment();
    d.contracts.LandTitleRegistry = registry.target;
    console.log(`  LandTitleRegistry ${registry.target}`);
  }
  // The registry deploys a LandTitleToken per parcel. On a chain with
  // contractDeployerAllowList that create is performed BY THE REGISTRY, so the
  // registry's own address must be allow-listed — otherwise tokenizeParcel
  // reverts with no reason string at all, which is unreadable from the error.
  // Run this on the reuse path too: a registry deployed before this check
  // existed is still missing the permission.
  await enableDeployer(ethers, deployer, registry.target, "LandTitleRegistry");
  if (d.contracts.LandCollateralVault) {
    vault = await ethers.getContractAt("LandCollateralVault", d.contracts.LandCollateralVault);
    console.log(`Using existing LandCollateralVault ${vault.target}`);
  } else {
    vault = await ethers.deployContract("LandCollateralVault", [
      registry.target, khr.target, deployer.address, deployer.address,
    ]);
    await vault.waitForDeployment();
    d.contracts.LandCollateralVault = vault.target;
    await (await khr.setSystemContract(vault.target, true)).wait();
    console.log(`  LandCollateralVault ${vault.target} (vetted to hold KHRt)`);
  }
  fs.writeFileSync(file, JSON.stringify(d, null, 2));

  // --- 2. cast ------------------------------------------------------------
  d.pilot = d.pilot ?? {};
  const cast = d.pilot.land ?? {};
  const need = async (key, label, tier) => {
    if (!cast[key]) {
      const w = ethers.Wallet.createRandom();
      cast[key] = { address: w.address, key: w.privateKey, label };
    }
    // Check the CHAIN, not the cache. deployments.json survives a chain reset
    // and a redeploy of the registry, so a cached account can name an address
    // the current IdentityRegistry has never heard of — and every later step
    // then fails on KYC for an account the script just claimed to have set up.
    if (!(await identity.isActive(cast[key].address))) {
      await (await identity.register(cast[key].address, ethers.id(`land-${key}-${cast[key].address}`), tier)).wait();
      console.log(`  registered ${label}: ${cast[key].address}`);
    } else {
      console.log(`  ${label}: ${cast[key].address}`);
    }
    // Top up every run, not only on creation — a reused demo account has been
    // spending gas since last time, and an empty one fails in a way that looks
    // like the policy rejecting the payment rather than a flat tank.
    await fundGas(ethers, deployer, cast[key].address);
    await enableTransactor(ethers, deployer, cast[key].address);
    return cast[key];
  };
  console.log("\nCast (KYC'd on chain):");
  const owner = await need("owner", "Landowner", 3);
  const buyer = await need("buyer", "Co-investor", 3);
  d.pilot.land = cast;
  fs.writeFileSync(file, JSON.stringify(d, null, 2));

  // --- 3. tokenize --------------------------------------------------------
  const parcelRef = process.env.CSB_PARCEL_REF ?? `demo-parcel-${Date.now()}`;
  const parcelId = ethers.id(parcelRef);
  let titleAddr = (await registry.parcelOf(parcelId)).token;
  if (titleAddr === ethers.ZeroAddress) {
    console.log(`\nTokenizing parcel "${parcelRef}" — 10,000 shares = 100% of the parcel…`);
    await (await registry.tokenizeParcel({
      parcelId,
      name: "Demo Land Title",
      symbol: "LAND1",
      location: "Demo Sangkat, Demo Khan (illustrative)",
      titleURI: "ipfs://placeholder-deed-hash",
      areaSqm: 450,
      totalShares: 10_000n,
      minimumTier: 2,
      firstOwner: owner.address,
    })).wait();
    titleAddr = (await registry.parcelOf(parcelId)).token;
  }
  const title = await ethers.getContractAt("LandTitleToken", titleAddr);
  console.log(`  Title token: ${titleAddr}`);
  console.log(`  Owner holds: ${await title.balanceOf(owner.address)} / ${await title.totalSupply()} shares (100%)`);
  console.log(`  Registered title? ${await registry.isRegisteredTitle(titleAddr)}`);

  const ow = new ethers.Wallet(owner.key, ethers.provider);

  // --- 4. sell a quarter --------------------------------------------------
  console.log("\n─── Selling 25% to a verified co-investor ───");
  if ((await title.balanceOf(buyer.address)) === 0n) {
    await (await title.connect(ow).transfer(buyer.address, 2_500n)).wait();
  }
  console.log(`  Owner  ${await title.balanceOf(owner.address)} shares`);
  console.log(`  Buyer  ${await title.balanceOf(buyer.address)} shares`);

  console.log("\n─── Trying to sell to an unverified address ───");
  const stranger = ethers.Wallet.createRandom().address;
  const [ok, why] = await title.canTransfer(owner.address, stranger, 1n);
  console.log(`  canTransfer → ${ok}`);
  console.log(`  reason      → "${why}"`);
  try {
    await (await title.connect(ow).transfer(stranger, 1n)).wait();
    console.log("  ✗ UNEXPECTED: it settled — compliance is not being enforced!");
    process.exitCode = 1;
  } catch (_) {
    console.log("  ✓ refused by the token itself — an unsanctioned trade cannot settle");
  }

  // --- 5. borrow against the land ----------------------------------------
  console.log("\n─── Borrowing KHRt against the land ───");
  if (!(await title.approvedCustodian(vault.target))) {
    await (await title.setApprovedCustodian(vault.target, true)).wait();
    console.log("  Registrar approved the vault as a custodian for this title");
  }
  const principal = 20_000_00n;
  const fundNeeded = principal * 2n;
  if ((await khr.balanceOf(vault.target)) < principal) {
    await (await khr.issue(deployer.address, fundNeeded)).wait();
    await (await khr.approve(vault.target, fundNeeded)).wait();
    await (await vault.fund(fundNeeded)).wait();
    console.log(`  Lender funded the vault with ${fmt(fundNeeded)} KHRt`);
  }

  const pledge = 5_000n;
  await (await title.connect(ow).approve(vault.target, pledge)).wait();
  const due = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  const before = await khr.balanceOf(owner.address);
  await (await vault.openLoan(owner.address, titleAddr, pledge, principal, due)).wait();

  console.log(`  Pledged ${pledge} shares (${(Number(pledge) / 100).toFixed(0)}% of the parcel)`);
  console.log(`  Borrowed ${fmt((await khr.balanceOf(owner.address)) - before)} KHRt`);
  console.log(`  Vault now holds ${await title.balanceOf(vault.target)} shares as collateral`);
  console.log(`  Owner's free shares: ${await title.balanceOf(owner.address)}`);

  console.log("\nWhat this shows: the registrar issued the title and still holds the");
  console.log("powers a court needs, but the lending contract was written against it");
  console.log("without anyone's coordination — it just checks the registry. That is");
  console.log("the argument for a shared ledger over a ministry database.");
  console.log("\nIllustrative demo — no real property, valueless test tokens.");
}

/**
 * Give a freshly generated demo account enough native tRIEL to pay for its own
 * transactions. Easy to forget and confusing when it bites: the account holds
 * KHRt but cannot move it, because every EVM transaction reserves
 * `gasPrice x gasLimit` from the NATIVE balance up front. Now that CSB prices
 * gas at about 1 tRIEL per payment, an unfunded demo account simply stalls.
 */
async function fundGas(ethers, deployer, to) {
  const target = ethers.parseEther(process.env.CSB_DEMO_GAS ?? "100");
  const bal = await ethers.provider.getBalance(to);
  if (bal >= target) return;
  await (await deployer.sendTransaction({ to, value: target - bal })).wait();
}

function fmt(units) {
  return (Number(units) / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

main().catch((e) => {
  console.error("\nFailed:", explain(e));
  process.exitCode = 1;
});
