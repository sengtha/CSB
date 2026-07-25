const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { enableTransactor, enableDeployer, explain } = require("./lib/csb-precompiles");

/**
 * ID Poor — programmable money you can watch work.
 *
 * Issues an earmarked food transfer to a household, then shows the two outcomes
 * that matter: the money reaches a licensed grocer, and the same money cannot be
 * handed to a moneylender. Deploys the social contracts on first run and records
 * them in deployments.json.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/demo-idpoor.js --network csbRemote
 *
 * ILLUSTRATIVE. "ID Poor" is referenced as a widely-understood example of
 * targeted social assistance. This is a personal design study — not built with,
 * for, or on behalf of anyone who administers such a programme — and it moves
 * valueless test tokens between generated demo accounts.
 */
const FOOD = 1 << 0;
const MEDICINE = 1 << 1;

async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();

  const identity = await ethers.getContractAt("IdentityRegistry", d.contracts.IdentityRegistry);
  const khr = await ethers.getContractAt("KHRStablecoin", d.contracts.KHRStablecoin);

  console.log(`Deployer / authorities: ${deployer.address}\n`);

  // A chain deployed before the assigned-spend-target upgrade is running a KHRt
  // without these functions. Calling one is a call to a selector the contract
  // does not have, which reverts with NO reason string — indistinguishable from
  // a permissions failure in the error. Check once, up front, and say plainly
  // what is wrong instead of letting it surface as "execution reverted".
  try {
    await khr.spendPolicy();
  } catch (_) {
    console.error(`The KHRt at ${khr.target} predates the assigned-spend-target upgrade —`);
    console.error(`it has no spendPolicy()/issueRestricted(), so this demo cannot run against it.\n`);
    console.error(`Redeploy the contract suite to pick up the new code:`);
    console.error(`    npx hardhat run scripts/deploy.js --network csbRemote`);
    console.error(`    npx hardhat run scripts/seed-accounts.js --network csbRemote`);
    console.error(`    npx hardhat run scripts/enable-charity-levy.js --network csbRemote\n`);
    console.error(`Note this replaces KHRt: token balances and the levy total start from zero.`);
    console.error(`Gas-fee routing is chain-level (RewardManager), so it is unaffected, and the`);
    console.error(`charity address keeps the tRIEL it has already collected.`);
    process.exitCode = 1;
    return;
  }

  // --- 1. contracts -------------------------------------------------------
  let merchants, programs;
  if (d.contracts.MerchantRegistry && d.contracts.SocialProgramRegistry) {
    merchants = await ethers.getContractAt("MerchantRegistry", d.contracts.MerchantRegistry);
    programs = await ethers.getContractAt("SocialProgramRegistry", d.contracts.SocialProgramRegistry);
    console.log(`Using existing MerchantRegistry     ${merchants.target}`);
    console.log(`Using existing SocialProgramRegistry ${programs.target}`);
  } else {
    console.log("Deploying social-assistance contracts…");
    merchants = await ethers.deployContract("MerchantRegistry", [deployer.address, deployer.address]);
    await merchants.waitForDeployment();
    programs = await ethers.deployContract("SocialProgramRegistry", [
      merchants.target, deployer.address, deployer.address,
    ]);
    await programs.waitForDeployment();
    d.contracts.MerchantRegistry = merchants.target;
    d.contracts.SocialProgramRegistry = programs.target;
    fs.writeFileSync(file, JSON.stringify(d, null, 2));
    console.log(`  MerchantRegistry      ${merchants.target}`);
    console.log(`  SocialProgramRegistry ${programs.target}`);
  }

  if ((await khr.spendPolicy()).toLowerCase() !== programs.target.toLowerCase()) {
    await (await khr.setSpendPolicy(programs.target)).wait();
    console.log("  KHRt spend policy wired to the programme registry");
  }

  // --- 2. cast ------------------------------------------------------------
  d.pilot = d.pilot ?? {};
  const cast = d.pilot.idpoor ?? {};
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
      await (await identity.register(cast[key].address, ethers.id(`idpoor-${key}-${cast[key].address}`), tier)).wait();
      console.log(`  registered ${label}: ${cast[key].address}`);
    } else {
      console.log(`  ${label}: ${cast[key].address}`);
    }
    // Top up every run, not only on creation — a reused demo account has been
    // spending gas since last time, and an empty one fails in a way that looks
    // like the policy rejecting the payment rather than a flat tank.
    await fundGas(ethers, deployer, cast[key].address);
    // KYC decides who may hold KHRt; the chain's txAllowList decides who may
    // send a transaction at all. Both are needed, and only the second produces
    // an error that looks nothing like a permissions problem.
    await enableTransactor(ethers, deployer, cast[key].address);
    return cast[key];
  };
  console.log("\nCast (KYC'd on chain):");
  const household = await need("household", "Household (assistance recipient)", 1);
  const grocer = await need("grocer", "Licensed food merchant", 3);
  const lender = await need("lender", "Moneylender (not a licensed merchant)", 3);
  d.pilot.idpoor = cast;
  fs.writeFileSync(file, JSON.stringify(d, null, 2));

  // --- 3. licensing + policy ---------------------------------------------
  if (!(await merchants.isRegistered(grocer.address))) {
    await (await merchants.registerMerchant(grocer.address, FOOD | MEDICINE, "Demo grocery stall")).wait();
    console.log("\nLicensed the grocer for FOOD + MEDICINE.");
  }
  // The moneylender is deliberately never licensed.

  let programId = cast.programId;
  if (!programId) {
    const rc = await (await programs.createProgram("Food assistance (demo)", FOOD, 0)).wait();
    programId = Number(await programs.programCount());
    cast.programId = programId;
    d.pilot.idpoor = cast;
    fs.writeFileSync(file, JSON.stringify(d, null, 2));
    console.log(`Created programme #${programId}: food only.`);
  }

  // --- 4. disburse --------------------------------------------------------
  const grant = 50_000_00n; // 50,000 riel
  console.log(`\nIssuing ${fmt(grant)} KHRt of food assistance to the household…`);
  await (await khr.issueRestricted(household.address, grant, programId)).wait();

  await show(khr, household.address, "Household");

  // --- 5. the two outcomes ------------------------------------------------
  const hh = new ethers.Wallet(household.key, ethers.provider);

  console.log("\n─── Paying the licensed grocer ───");
  const spend = 12_000_00n;
  const [okGrocer] = await khr.canSpend(household.address, grocer.address, spend);
  console.log(`  canSpend → ${okGrocer}`);
  await (await khr.connect(hh).transfer(grocer.address, spend)).wait();
  console.log(`  ✓ paid ${fmt(spend)} KHRt for food`);
  await show(khr, household.address, "Household");
  console.log(`  Grocer received: ${fmt(await khr.balanceOf(grocer.address))} KHRt (ordinary money — the earmark does not follow)`);

  console.log("\n─── Trying to pay the moneylender ───");
  const [okLender, why] = await khr.canSpend(household.address, lender.address, 1_000_00n);
  console.log(`  canSpend → ${okLender}`);
  console.log(`  reason   → "${why}"`);
  try {
    await (await khr.connect(hh).transfer(lender.address, 1_000_00n)).wait();
    console.log("  ✗ UNEXPECTED: the transfer succeeded — the policy is not being enforced!");
    process.exitCode = 1;
  } catch (e) {
    console.log("  ✓ refused by the chain (SpendTargetNotPermitted)");
  }

  console.log("\n─── The household's OWN money is still their own ───");
  await (await khr.issue(household.address, 8_000_00n)).wait(); // e.g. wages
  console.log(`  Issued ${fmt(8_000_00n)} KHRt of ordinary income`);
  await show(khr, household.address, "Household");
  await (await khr.connect(hh).transfer(lender.address, 8_000_00n)).wait();
  console.log(`  ✓ paid the moneylender ${fmt(8_000_00n)} KHRt from their own earnings`);
  await show(khr, household.address, "Household");

  console.log("\nWhat this shows: the restriction is a property of the money, not a");
  console.log("report written afterwards. Assistance can only reach a licensed food");
  console.log("merchant, while everything the household earns stays fully theirs.");
  console.log("\nIllustrative demo — valueless test tokens, generated demo accounts.");
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

async function show(khr, addr, label) {
  const total = await khr.balanceOf(addr);
  const restricted = await khr.restrictedBalance(addr);
  const free = await khr.unrestrictedBalanceOf(addr);
  console.log(`  ${label}: ${fmt(total)} KHRt total = ${fmt(restricted)} earmarked + ${fmt(free)} own`);
}

main().catch((e) => {
  console.error("\nFailed:", explain(e));
  process.exitCode = 1;
});
