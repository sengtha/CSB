const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Seeds a freshly deployed suite with demo data for the wallet/explorer/admin
 * UIs. Assumes the deployer holds all roles (devnet). Reads addresses from
 * demo/deployments.json (written by scripts/deploy.js) and appends the demo
 * account keys to it.
 *
 * Demo cast:
 *   Sokha  — tier 2 citizen (full KYC), funded
 *   Dara   — tier 1 citizen (capped),  funded
 *   Vanna  — not KYC'd (every action involving Vanna fails, on purpose)
 */
async function main() {
  const file = path.join(__dirname, "..", "demo", "deployments.json");
  const deployments = JSON.parse(fs.readFileSync(file, "utf8"));
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();

  const identity = await ethers.getContractAt("IdentityRegistry", deployments.contracts.IdentityRegistry);
  const khr = await ethers.getContractAt("KHRStablecoin", deployments.contracts.KHRStablecoin);
  const gateway = await ethers.getContractAt("EgressGateway", deployments.contracts.EgressGateway);

  const sokha = ethers.Wallet.createRandom().connect(ethers.provider);
  const dara = ethers.Wallet.createRandom().connect(ethers.provider);
  const vanna = ethers.Wallet.createRandom().connect(ethers.provider);

  // Fund native gas. On the real CSB L1 fees are zero and this is unnecessary;
  // on a local Hardhat node the demo accounts need gas money.
  const feeData = await ethers.provider.getFeeData();
  if (feeData.gasPrice === null || feeData.gasPrice > 0n) {
    for (const w of [sokha, dara, vanna]) {
      await (await deployer.sendTransaction({ to: w.address, value: ethers.parseEther("1") })).wait();
    }
  }

  await (await identity.register(sokha.address, ethers.id("moi-identity-sokha"), 2)).wait();
  await (await identity.register(dara.address, ethers.id("moi-identity-dara"), 1)).wait();

  await (await khr.issue(sokha.address, 5_000_000_00)).wait(); // 5,000,000.00 KHRt
  await (await khr.issue(dara.address, 1_000_000_00)).wait();
  await (await khr.setTierTransferCap(1, 400_000_00)).wait(); // tier-1 cap: 400,000 KHRt/transfer

  // Permit KHRt egress to the demo destination through the mock adapter:
  // tier 2 minimum, 1,000,000 KHRt daily cap.
  const destChain = ethers.id("avalanche-c-chain");
  await (
    await gateway.setTokenPolicy(khr.target, true, 2, 1_000_000_00, deployments.contracts.MockBridgeAdapter)
  ).wait();

  deployments.demo = {
    destinationChain: { label: "Avalanche C-Chain", id: destChain },
    accounts: {
      sokha: { address: sokha.address, key: sokha.privateKey, tier: 2, note: "full KYC, funded" },
      dara: { address: dara.address, key: dara.privateKey, tier: 1, note: "capped tier, funded" },
      vanna: { address: vanna.address, key: vanna.privateKey, tier: 0, note: "NOT KYC'd — demo failure cases" },
    },
    deployerKey: null,
  };
  fs.writeFileSync(file, JSON.stringify(deployments, null, 2));

  console.log("Demo data seeded:");
  console.log(`  Sokha (tier 2): ${sokha.address}`);
  console.log(`  Dara  (tier 1): ${dara.address}`);
  console.log(`  Vanna (no KYC): ${vanna.address}`);
  console.log(`\nKeys written to ${file} — DEVNET ONLY, never reuse these keys.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
