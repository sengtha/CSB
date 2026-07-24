const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Fund the existing pilot accounts with native gas token (tRIEL).
 *
 * Why this exists: the wallet's "Send payment" button submits a real EVM
 * transaction (`KHRStablecoin.transfer`). Even when the CSB fee floor is set to
 * zero, the node still reserves `maxFeePerGas * gasLimit` from the sender's
 * NATIVE balance up front — a pilot account holding KHRt but zero tRIEL cannot
 * pass that check. This mints a little tRIEL to each pilot account via the
 * Native Minter precompile (the deployer is its admin).
 *
 * Fee handling: this chain's effective base fee can jump well above the fee
 * floor (Subnet-EVM block gas cost — ~170 gwei observed), and ethers' automatic
 * fee estimate can under-price a tx so it gets stuck unmined in the mempool
 * (wait() then hangs forever). We therefore price every tx EXPLICITLY, far
 * above the current base fee, and cap wait() with a timeout so a stuck tx
 * surfaces instead of hanging.
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

  // Explicit, robust fee: well above the current base fee so txs can't get stuck
  // under-priced in the mempool. Overpaying is harmless — the node only charges
  // the actual base fee, and the deployer holds ~1,000,000 tRIEL.
  const block = await ethers.provider.getBlock("latest");
  const baseFee = block?.baseFeePerGas ?? 0n;
  const bump = ethers.parseUnits("500", "gwei");
  const fees = {
    maxFeePerGas: baseFee * 3n + bump,
    maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
  };
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Deployer native balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} tRIEL`);
  console.log(`Current base fee: ${ethers.formatUnits(baseFee, "gwei")} gwei`);
  console.log(`Pricing txs at maxFeePerGas ${ethers.formatUnits(fees.maxFeePerGas, "gwei")} gwei`);
  console.log(`Topping each account up to ${ethers.formatEther(target)} tRIEL\n`);

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

  const minter = new ethers.Contract(NATIVE_MINTER, MINTER_ABI, deployer);
  let canMint = false;
  try {
    canMint = (await minter.readAllowList(deployer.address)) > 0n;
  } catch (_) {
    // Native Minter not enabled / not readable — fall back to a value transfer.
  }
  console.log(canMint ? "Funding via Native Minter precompile.\n" : "Native Minter unavailable — funding via value transfer.\n");

  for (const r of recipients) {
    const bal = await ethers.provider.getBalance(r.address);
    if (bal >= target) {
      console.log(`  ${r.name} ${r.address} — already ${ethers.formatEther(bal)} tRIEL, skipping`);
      continue;
    }
    const need = target - bal;
    const tx = canMint
      ? await minter.mintNativeCoin(r.address, need, fees)
      : await deployer.sendTransaction({ to: r.address, value: need, ...fees });
    console.log(`  ${r.name} ${r.address} — ${canMint ? "minting" : "sending"} ${ethers.formatEther(need)} tRIEL … tx ${tx.hash}`);
    const receipt = await waitWithTimeout(ethers.provider, tx.hash, 90_000);
    if (!receipt) {
      console.log(`    ⏳ not mined within 90s — tx ${tx.hash} is stuck (base fee likely rose above the price). Re-run to retry.`);
      return;
    }
    console.log(`    ✓ mined in block ${receipt.blockNumber}`);
  }

  console.log("\nDone. Pilot accounts can now pay gas; reload the wallet and Send payment will work.");
}

// Poll for the receipt (the Hardhat provider implements getTransactionReceipt
// but not waitForTransaction). Return null after `ms` so a stuck tx never hangs.
async function waitWithTimeout(provider, hash, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt) return receipt;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return null;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
