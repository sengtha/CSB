const hre = require("hardhat");

/**
 * Deploys the CSB v0 contract suite. Role holders default to the deployer for
 * devnet runs; override with env vars for real deployments:
 *   COUNCIL_ADDR  - PM-council multisig (root admin, gateway governor)
 *   MOI_ADDR      - Ministry of Interior issuer multisig (KYC issuance)
 *   ENFORCER_ADDR - judicial/AML authority multisig (freeze/confiscate)
 *   ISSUER_ADDR   - KHR stablecoin issuer (pluggable; NBC / bank consortium)
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const council = process.env.COUNCIL_ADDR ?? deployer.address;
  const moi = process.env.MOI_ADDR ?? deployer.address;
  const enforcer = process.env.ENFORCER_ADDR ?? deployer.address;
  const issuer = process.env.ISSUER_ADDR ?? deployer.address;

  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Council:   ${council}\nMoI:       ${moi}\nEnforcer:  ${enforcer}\nIssuer:    ${issuer}\n`);

  const identity = await hre.ethers.deployContract("IdentityRegistry", [council, moi]);
  await identity.waitForDeployment();
  console.log(`IdentityRegistry:    ${identity.target}`);

  const enforcement = await hre.ethers.deployContract("EnforcementRegistry", [council, enforcer]);
  await enforcement.waitForDeployment();
  console.log(`EnforcementRegistry: ${enforcement.target}`);

  const khr = await hre.ethers.deployContract("KHRStablecoin", [
    identity.target,
    enforcement.target,
    council,
    issuer,
  ]);
  await khr.waitForDeployment();
  console.log(`KHRStablecoin:       ${khr.target}`);

  const gateway = await hre.ethers.deployContract("EgressGateway", [
    identity.target,
    enforcement.target,
    council,
  ]);
  await gateway.waitForDeployment();
  console.log(`EgressGateway:       ${gateway.target}`);

  const adapter = await hre.ethers.deployContract("MockBridgeAdapter", [council]);
  await adapter.waitForDeployment();
  console.log(`MockBridgeAdapter:   ${adapter.target}`);

  // Grant the enforcement authority its token-level power and wire the adapter
  // when the deployer holds the admin roles (devnet convenience).
  if (council === deployer.address) {
    await (await khr.grantRole(await khr.ENFORCER_ROLE(), enforcer)).wait();
    await (await adapter.setGateway(gateway.target)).wait();
    await (await khr.setSystemContract(adapter.target, true)).wait();
    console.log("\nDevnet wiring complete (ENFORCER_ROLE granted, adapter gateway set, adapter marked as system contract).");
  } else {
    console.log(
      "\nNOTE: council is a multisig — via the multisig: grant KHR ENFORCER_ROLE, call adapter.setGateway, and mark the adapter as a system contract on KHR."
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
