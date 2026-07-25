const hre = require("hardhat");

/**
 * Clear any stuck (under-priced) deployer transactions by replacing each pending
 * nonce with a 0-value self-transfer at the network's configured gasPrice (which
 * is high enough to mine). Run this if a deploy/admin script hung mid-run before
 * re-trying it.
 *
 *   CSB_RPC_URL=$RPC CSB_CHAIN_ID=8555 CSB_DEPLOYER_KEY=0x... \
 *     npx hardhat run scripts/unstick.js --network csbRemote
 */
async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  const provider = ethers.provider;

  const latest = await provider.getTransactionCount(deployer.address, "latest");
  const pending = await provider.getTransactionCount(deployer.address, "pending");
  console.log(`Deployer ${deployer.address}`);
  console.log(`Nonce: mined=${latest} pending=${pending}`);

  if (pending <= latest) {
    console.log("No stuck transactions — safe to re-run your script.");
    return;
  }

  for (let n = latest; n < pending; n++) {
    const tx = await deployer.sendTransaction({ to: deployer.address, value: 0, nonce: n });
    console.log(`  replacing stuck nonce ${n} … ${tx.hash}`);
    await tx.wait();
    console.log(`  ✓ mined`);
  }
  console.log("\nUnstuck. Re-run your deploy/admin script now.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
