const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { TX_ALLOWLIST, DEPLOYER_ALLOWLIST } = require("./lib/csb-precompiles");

/**
 * Why did that revert? Read-only preflight for the demo scripts.
 *
 * A permissioned chain refuses things for reasons that never reach the error
 * message: Subnet-EVM's allow-list precompiles reject before any contract runs,
 * so the provider reports a bare "execution reverted" with no data to decode.
 * This checks each precondition separately and names the one that is missing.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/check-demo-ready.js --network csbRemote
 */
const ALLOWLIST_ABI = ["function readAllowList(address addr) view returns (uint256)"];
const ROLE = { 0: "NOT ALLOWED", 1: "enabled", 2: "admin", 3: "manager" };

async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();
  let problems = 0;
  const bad = (m) => { problems++; console.log(`  ✗ ${m}`); };
  const ok = (m) => console.log(`  ✓ ${m}`);

  console.log(`Chain ${(await ethers.provider.getNetwork()).chainId}, deployer ${deployer.address}\n`);

  // --- chain-level permissions -------------------------------------------
  console.log("Chain allow lists (these reject BEFORE any contract runs)");
  const tx = new ethers.Contract(TX_ALLOWLIST, ALLOWLIST_ABI, ethers.provider);
  const dep = new ethers.Contract(DEPLOYER_ALLOWLIST, ALLOWLIST_ABI, ethers.provider);
  let hasPrecompiles = true;
  try {
    const r = await tx.readAllowList(deployer.address);
    ok(`deployer may transact (${ROLE[Number(r)] ?? r})`);
  } catch (_) {
    hasPrecompiles = false;
    console.log("  – no allow-list precompiles on this chain (local dev node); skipping");
  }

  if (hasPrecompiles) {
    const depRole = await dep.readAllowList(deployer.address);
    if (depRole === 0n) bad("deployer may NOT create contracts — the demos deploy their own contracts");
    else ok(`deployer may create contracts (${ROLE[Number(depRole)] ?? depRole})`);

    // The factory case that produces an unreadable revert.
    const reg = d.contracts?.LandTitleRegistry;
    if (reg) {
      const r = await dep.readAllowList(reg);
      if (r === 0n) {
        bad(`LandTitleRegistry ${reg} may NOT create contracts.`);
        console.log("      It deploys a LandTitleToken per parcel, so tokenizeParcel reverts");
        console.log("      with no reason string. scripts/demo-land.js now fixes this on start.");
      } else ok("LandTitleRegistry may create title tokens");
    }

    // Every generated demo account needs to be able to send transactions.
    for (const group of ["idpoor", "land"]) {
      for (const [key, a] of Object.entries(d.pilot?.[group] ?? {})) {
        if (!a || typeof a !== "object" || !a.address) continue;
        const r = await tx.readAllowList(a.address);
        if (r === 0n) bad(`${group}.${key} ${a.address} may NOT send transactions (txAllowList)`);
        else ok(`${group}.${key} may transact`);
      }
    }
  }

  // --- contract-level state ----------------------------------------------
  console.log("\nContract state");
  const identity = await ethers.getContractAt("IdentityRegistry", d.contracts.IdentityRegistry);
  const khr = await ethers.getContractAt("KHRStablecoin", d.contracts.KHRStablecoin);

  if (!(await identity.isActive(deployer.address))) {
    console.log("  – deployer has no KYC attestation (fine unless it must hold KHRt;");
    console.log("    demo-land registers it automatically, since the lender holds KHRt)");
  } else ok("deployer holds an active KYC attestation");

  const roles = [
    ["ISSUER_ROLE on KHRt", await khr.ISSUER_ROLE(), khr],
    ["DEFAULT_ADMIN_ROLE on KHRt", ethers.ZeroHash, khr],
  ];
  for (const [label, role, c] of roles) {
    if (await c.hasRole(role, deployer.address)) ok(`deployer has ${label}`);
    else bad(`deployer LACKS ${label}`);
  }

  const policy = await khr.spendPolicy();
  if (policy === ethers.ZeroAddress) {
    console.log("  – KHRt spend policy not set yet (demo-idpoor sets it)");
  } else ok(`KHRt spend policy → ${policy}`);

  // Gas: with a real fee, an unfunded demo account fails in a way that reads
  // like a permissions problem.
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`\nDeployer native balance: ${ethers.formatEther(bal)} tRIEL`);
  if (bal < ethers.parseEther("500")) {
    bad("low — the demos fund several accounts with 100 tRIEL each");
  }

  console.log(problems === 0
    ? "\nReady. Run the demos."
    : `\n${problems} problem(s) above would make a demo revert. Re-running the demo script fixes the allow-list ones.`);
  if (problems > 0) process.exitCode = 1;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
