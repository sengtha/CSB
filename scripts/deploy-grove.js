const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { enableDeployer, explain } = require("./lib/csb-precompiles");

/**
 * Deploy the Grove suite onto a chain that already has CSB on it.
 *
 * `deploy.js` builds a chain from nothing and would redeploy the identity
 * registry, the stablecoin, and everything else with it — which on a live chain
 * means abandoning every KYC attestation and balance already recorded. This
 * script only adds what is missing, reading the existing addresses out of
 * app/deployments.json and writing the new ones back beside them.
 *
 * Idempotent by design: run it as often as you like. Anything already recorded
 * is reused, and every wiring step is checked before it is performed, so a
 * half-finished run is fixed by running it again.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/deploy-grove.js --network csbRemote
 *
 * Role holders default to the deployer, as the rest of the suite does. For a
 * real deployment give each one its own institutional multisig — the whole
 * argument of this design is that the office appointing verifiers is not the
 * office deciding what a verifier's signature is worth:
 *
 *   COUNCIL_ADDR             chain governance (verification threshold, tiers)
 *   ATTESTER_REGISTRAR_ADDR  licenses and suspends field verifiers
 *   GROVE_AUTHORITY_ADDR     registers groves and issues their titles
 *   PLEDGE_ARBITER_ADDR      resolves disputed pledge milestones
 */
async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  if (!fs.existsSync(file)) {
    throw Object.assign(new Error(`no deployments file at ${file} — run scripts/deploy.js first`), {
      code: "NO_DEPLOYMENT",
    });
  }
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();

  for (const need of ["IdentityRegistry", "EnforcementRegistry", "KHRStablecoin"]) {
    if (!d.contracts?.[need]) throw new Error(`${need} is not in ${file} — deploy the base suite first`);
  }

  const council = process.env.COUNCIL_ADDR ?? deployer.address;
  const registrar = process.env.ATTESTER_REGISTRAR_ADDR ?? deployer.address;
  const groveAuthority = process.env.GROVE_AUTHORITY_ADDR ?? deployer.address;
  const arbiter = process.env.PLEDGE_ARBITER_ADDR ?? deployer.address;

  console.log(`Deployer:            ${deployer.address}`);
  console.log(`Council:             ${council}`);
  console.log(`Attester registrar:  ${registrar}`);
  console.log(`Grove authority:     ${groveAuthority}`);
  console.log(`Pledge arbiter:      ${arbiter}\n`);
  if (council === deployer.address) {
    console.log("NOTE: every role is the deployer. Fine for a pilot; for anything");
    console.log("real, set the env vars above to separate institutional multisigs.\n");
  }

  const attesters = await ensure(d, "AttesterRegistry", () =>
    ethers.deployContract("AttesterRegistry", [council, registrar]));
  const anchor = await ensure(d, "GroveAnchor", () =>
    ethers.deployContract("GroveAnchor", [
      d.contracts.IdentityRegistry, d.contracts.EnforcementRegistry, attesters.target, council,
    ]));
  const registry = await ensure(d, "GroveTitleRegistry", () =>
    ethers.deployContract("GroveTitleRegistry", [
      d.contracts.IdentityRegistry, d.contracts.EnforcementRegistry, anchor.target, council, groveAuthority,
    ]));
  const pledge = await ensure(d, "GrovePledge", () =>
    ethers.deployContract("GrovePledge", [anchor.target, council, arbiter]));

  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log("");

  // --- wiring, each step checked before it is taken ------------------------

  // The anchor writes verifier reputation into the licence registry. Without
  // this the anchor's try/catch swallows the failure and confirmation counts
  // silently stop accruing — verification still works, reputation does not.
  const RECORDER = await attesters.RECORDER_ROLE();
  if (await attesters.hasRole(RECORDER, anchor.target)) {
    console.log("✓ GroveAnchor already holds RECORDER_ROLE on AttesterRegistry");
  } else if (await attesters.hasRole(await attesters.DEFAULT_ADMIN_ROLE(), deployer.address)) {
    await (await attesters.grantRole(RECORDER, anchor.target)).wait();
    console.log("✓ granted GroveAnchor RECORDER_ROLE on AttesterRegistry");
  } else {
    console.log(`! COUNCIL ACTION NEEDED: AttesterRegistry.grantRole(${RECORDER}, ${anchor.target})`);
  }

  // GroveTitleRegistry deploys a GroveTitle per grove, and that create is
  // performed BY THE REGISTRY's own address. On a chain with
  // contractDeployerAllowList, missing this makes registerGrove revert with no
  // reason string whatsoever — the least debuggable failure on this chain.
  await enableDeployer(ethers, deployer, registry.target, "GroveTitleRegistry");

  // GrovePledge custodies KHRt and has no personal identity to verify, so the
  // council vets it as a system contract exactly as it vets the escrow and the
  // bridge adapter. Without this every fund() reverts on the KYC check.
  const khr = await ethers.getContractAt("KHRStablecoin", d.contracts.KHRStablecoin);
  if (await khr.isSystemContract(pledge.target)) {
    console.log("✓ GrovePledge already vetted as a KHRt system contract");
  } else if (await khr.hasRole(await khr.DEFAULT_ADMIN_ROLE(), deployer.address)) {
    await (await khr.setSystemContract(pledge.target, true)).wait();
    console.log("✓ vetted GrovePledge as a KHRt system contract (may custody KHRt)");
  } else {
    console.log(`! COUNCIL ACTION NEEDED: KHRStablecoin.setSystemContract(${pledge.target}, true)`);
  }

  // --- report -------------------------------------------------------------

  console.log("\nGrove suite:");
  for (const name of ["AttesterRegistry", "GroveAnchor", "GroveTitleRegistry", "GrovePledge"]) {
    console.log(`  ${name.padEnd(20)} ${d.contracts[name]}`);
  }
  console.log(`\nrequiredConfirmations ${await anchor.requiredConfirmations()} · minimumTier ${await anchor.minimumTier()}`);
  console.log(`Public read endpoint: GET /grove?plot=<keccak256(plot)> on the app server`);
  console.log(`\nNext: license at least one field verifier, or nothing can ever be verified:`);
  console.log(`  AttesterRegistry.licenseAttester(<address>, <classes>, <licenceRef>, "<label>")`);
  console.log(`Class bits: agronomist 1 · commune 2 · school 4 · cooperative 8 · ngo 16 · auditor 32`);
  console.log(`\nRestart the app server so /grove picks up the new addresses.`);
}

/** Deploy only if deployments.json does not already name one. */
async function ensure(d, name, deploy) {
  const { ethers } = hre;
  if (d.contracts[name]) {
    console.log(`Using existing ${name.padEnd(20)} ${d.contracts[name]}`);
    return ethers.getContractAt(name, d.contracts[name]);
  }
  const c = await deploy();
  await c.waitForDeployment();
  d.contracts[name] = c.target;
  console.log(`Deployed       ${name.padEnd(20)} ${c.target}`);
  return c;
}

main().catch((e) => {
  console.error("\nFailed:", explain(e));
  process.exitCode = 1;
});
