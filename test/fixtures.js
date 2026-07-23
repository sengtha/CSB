const { ethers } = require("hardhat");

const ID_ALICE = ethers.id("moi-identity-alice");
const ID_BOB = ethers.id("moi-identity-bob");
const ORDER_REF = ethers.id("court-order-2026-001");
const PAYMENT_REF = ethers.id("moi-receipt-0001");
const DEST_CHAIN = ethers.id("avalanche-c-chain");

/** Deploys the full suite. council/moi/enforcer/issuer are distinct signers so
 *  tests exercise the separation of powers rather than a single super-admin. */
async function deploySuite() {
  const [council, moi, enforcer, issuer, alice, bob, outsider] = await ethers.getSigners();

  const identity = await ethers.deployContract("IdentityRegistry", [council.address, moi.address]);
  const enforcement = await ethers.deployContract("EnforcementRegistry", [council.address, enforcer.address]);
  const khr = await ethers.deployContract("KHRStablecoin", [
    identity.target,
    enforcement.target,
    council.address,
    issuer.address,
  ]);
  await khr.connect(council).grantRole(await khr.ENFORCER_ROLE(), enforcer.address);

  const gateway = await ethers.deployContract("EgressGateway", [
    identity.target,
    enforcement.target,
    council.address,
  ]);
  const adapter = await ethers.deployContract("MockBridgeAdapter", [council.address]);
  await adapter.connect(council).setGateway(gateway.target);
  await khr.connect(council).setSystemContract(adapter.target, true);

  return { identity, enforcement, khr, gateway, adapter, council, moi, enforcer, issuer, alice, bob, outsider };
}

module.exports = { deploySuite, ID_ALICE, ID_BOB, ORDER_REF, PAYMENT_REF, DEST_CHAIN };
