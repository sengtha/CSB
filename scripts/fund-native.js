const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Fund the existing pilot accounts with native gas token (tRIEL).
 *
 * Why this exists: the wallet's "Send payment" button submits a real EVM
 * transaction (`KHRStablecoin.transfer`). Even when the CSB fee floor is set to
 * zero, the node still reserves `maxFeePerGas * gasLimit` from the sender's
 * NATIVE balance up front — and ethers populates a non-zero maxFeePerGas from
 * the node's fee suggestion. A pilot account that holds KHRt but zero tRIEL
 * therefore cannot pass that upfront check, and every transfer reverts with an
 * "insufficient funds for gas" error. Seeding issued KHRt but (on the real
 * chain) skipped native funding, so the pilot accounts had no gas money.
 *
 * This mints a small amount of tRIEL straight to each pilot account via the
 * Native Minter precompile (the deployer is its admin). Minting — rather than
 * transferring from the deployer's genesis allocation — keeps the deployer's
 * balance intact and is exactly what that precompile is for.
 *
 * Usage (on the VM, with the deployer key):
 *   CSB_RPC_URL=$RPC CSB_CHAIN_ID=8555 CSB_DEPLOYER_KEY=0x... \
 *     npx hardhat run scripts/fund-native.js --network csbRemote
 *
 * Optional env:
 *   CSB_FUND_AMOUNT   tRIEL to top each account up to (default "10")
 *   CSB_FUND_EXTRA    comma-separated extra addresses to fund as well
 */
const NATIVE_MINTER = "0x0200000000000000000000000000000000000001";
const MINTER_ABI = [
  "function mintNativeCoin(address addr, uint256 amount)",
  "function readAllowList(address addr) view returns (uint256)",
];

async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  const deployments = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();

  const target = ethers.parseEther(process.env.CSB_FUND_AMOUNT ?? "10");

  // Collect recipients: every seeded pilot account plus any explicit extras.
  const recipients = [];
  for (const [name, a] of Object.entries(deployments.pilot?.accounts ?? {})) {
    recipients.push({ name, address: a.address });
  }
  for (const addr of (process.env.CSB_FUND_EXTRA ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    recipients.push({ name: "extra", address: addr });
  }
  if (recipients.length === 0) {
    throw new Error("No recipients — deployments.json has no pilot.accounts and CSB_FUND_EXTRA is empty.");
  }

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Deployer native balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} tRIEL`);
  console.log(`Topping each account up to ${ethers.formatEther(target)} tRIEL\n`);

  const minter = new ethers.Contract(NATIVE_MINTER, MINTER_ABI, deployer);

  // Is the deployer allowed to mint? (allowList role: 0 = none, 1 = enabled, 2 = admin)
  let canMint = false;
  try {
    canMint = (await minter.readAllowList(deployer.address)) > 0n;
  } catch (_) {
    // Native Minter precompile not enabled / not readable — fall back to transfer.
  }

  for (const r of recipients) {
    const bal = await ethers.provider.getBalance(r.address);
    if (bal >= target) {
      console.log(`  ${r.name} ${r.address} — already ${ethers.formatEther(bal)} tRIEL, skipping`);
      continue;
    }
    const need = target - bal;
    if (canMint) {
      await (await minter.mintNativeCoin(r.address, need)).wait();
      console.log(`  ${r.name} ${r.address} — minted ${ethers.formatEther(need)} tRIEL`);
    } else {
      await (await deployer.sendTransaction({ to: r.address, value: need })).wait();
      console.log(`  ${r.name} ${r.address} — sent ${ethers.formatEther(need)} tRIEL from deployer`);
    }
  }

  console.log("\nDone. Pilot accounts can now pay gas; the wallet 'Send payment' button will work.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
