const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deploys the CSB v0 contract suite. Role holders default to the deployer for
 * devnet runs; override with env vars for real deployments:
 *   COUNCIL_ADDR  - Governing-Council multisig (root admin, gateway governor)
 *   IDENTITY_ADDR      - Identity Authority issuer multisig (KYC issuance)
 *   ENFORCER_ADDR - judicial/AML authority multisig (freeze/confiscate)
 *   ISSUER_ADDR   - KHR stablecoin issuer (pluggable placeholder)
 */
async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const council = process.env.COUNCIL_ADDR ?? deployer.address;
  const idAuthority = process.env.IDENTITY_ADDR ?? deployer.address;
  const enforcer = process.env.ENFORCER_ADDR ?? deployer.address;
  const issuer = process.env.ISSUER_ADDR ?? deployer.address;

  console.log(`Deployer:  ${deployer.address}`);
  console.log(`Council:   ${council}\nIdentity Authority:       ${idAuthority}\nEnforcer:  ${enforcer}\nIssuer:    ${issuer}\n`);

  const identity = await hre.ethers.deployContract("IdentityRegistry", [council, idAuthority]);
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

  // Native coin (tRIEL) <-> tokenized-riel converter. Native Minter precompile
  // lives at 0x…01 on CSB; the converter must be allow-listed on it to mint.
  const NATIVE_MINTER = "0x0200000000000000000000000000000000000001";
  const converter = await hre.ethers.deployContract("RielConverter", [council, NATIVE_MINTER]);
  await converter.waitForDeployment();
  console.log(`RielConverter:       ${converter.target}`);

  // Native-tRIEL payments with an OPTIONAL public-good levy (off by default), so
  // CSB is usable before any tokenized-riel (KHRt) is licensed.
  const publicFund = process.env.PUBLIC_FUND_ADDR ?? council;
  const rielPay = await hre.ethers.deployContract("RielPay", [council, publicFund]);
  await rielPay.waitForDeployment();
  console.log(`RielPay:             ${rielPay.target}  (levy off; publicFund ${publicFund})`);

  // Escrow for multi-party settlement (delivery orders and the like).
  const escrow = await hre.ethers.deployContract("PaymentEscrow", [council, council]);
  await escrow.waitForDeployment();
  console.log(`PaymentEscrow:       ${escrow.target}  (arbiter ${council})`);

  // A mintable, KYC-gated NFT — the thing a visitor can try for themselves.
  const collectible = await hre.ethers.deployContract("CSBCollectible", [
    identity.target, enforcement.target, council,
  ]);
  await collectible.waitForDeployment();
  console.log(`CSBCollectible:      ${collectible.target}  (on-chain artwork)`);

  // Grant the enforcement authority its token-level power and wire the adapter
  // when the deployer holds the admin roles (devnet convenience).
  if (council === deployer.address) {
    await (await khr.grantRole(await khr.ENFORCER_ROLE(), enforcer)).wait();
    await (await adapter.setGateway(gateway.target)).wait();
    await (await khr.setSystemContract(adapter.target, true)).wait();
    // RielConverter: let it custody KHRt without KYC, and approve KHRt for conversion.
    await (await khr.setSystemContract(converter.target, true)).wait();
    await (await converter.setApproved(khr.target, true)).wait();
    // The escrow custodies KHRt on behalf of orders and has no personal KYC
    // attestation, so it needs the same vetting the adapter and converter get.
    await (await khr.setSystemContract(escrow.target, true)).wait();
    // Allow-list the converter on the Native Minter so it can mint tRIEL against
    // locked collateral. No-op on a local node without the precompile.
    try {
      const minterAllow = new hre.ethers.Contract(NATIVE_MINTER, ["function setEnabled(address addr)"], deployer);
      await (await minterAllow.setEnabled(converter.target)).wait();
      console.log("RielConverter enabled on the Native Minter allow list.");
    } catch (e) {
      console.log(`(Native Minter enable skipped — set it manually on-chain: ${e.shortMessage ?? e.message})`);
    }
    console.log("\nDevnet wiring complete (ENFORCER_ROLE, adapter gateway + system-contract, converter system-contract + KHRt approved).");
  } else {
    console.log(
      "\nNOTE: council is a multisig — via the multisig: grant KHR ENFORCER_ROLE; adapter.setGateway; mark adapter AND RielConverter as system contracts on KHR; converter.setApproved(KHRt); and allow-list the RielConverter on the Native Minter precompile."
    );
  }

  const deployments = {
    network: hre.network.name,
    chainId: Number((await hre.ethers.provider.getNetwork()).chainId),
    contracts: {
      IdentityRegistry: identity.target,
      EnforcementRegistry: enforcement.target,
      KHRStablecoin: khr.target,
      EgressGateway: gateway.target,
      MockBridgeAdapter: adapter.target,
      RielConverter: converter.target,
      RielPay: rielPay.target,
      PaymentEscrow: escrow.target,
      CSBCollectible: collectible.target,
    },
    roles: { council, idAuthority, enforcer, issuer },
  };
  const outPath = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  // Carry the `pilot` block across a redeploy. It holds PRIVATE KEYS — the only
  // copy that exists anywhere, since this file is gitignored — for the pilot
  // cast, the escrow cast, the ID-Poor and land demos, plus the charity record
  // the fee-routing scripts read. Writing a fresh object here silently
  // destroyed all of it every time the suite was redeployed, and a lost key is
  // lost for good.
  //
  // The keys stay valid; what does NOT survive is their state on chain. New
  // contracts mean an empty IdentityRegistry, so the seeded accounts hold no
  // KYC and no KHRt until they are re-registered. Re-running seed-accounts.js
  // reuses these same keys and re-registers them.
  let carried = null;
  try { carried = JSON.parse(fs.readFileSync(outPath, "utf8")).pilot ?? null; } catch (_) { /* first deploy */ }
  if (carried) deployments.pilot = carried;

  fs.writeFileSync(outPath, JSON.stringify(deployments, null, 2));
  console.log(`\nWrote ${outPath}`);
  if (carried) {
    console.log("Kept the existing `pilot` block (keys preserved). Those accounts are NOT");
    console.log("registered on the new contracts — re-run scripts/seed-accounts.js.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
