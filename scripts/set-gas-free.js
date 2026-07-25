const hre = require("hardhat");

/**
 * Set gas free on CSB by lowering the fee config's minBaseFee to 0 via the
 * feeManager precompile (deployer is admin). The chain uses constant gas
 * pricing, so base fee == minBaseFee — setting it to 0 makes gas genuinely free.
 * Every other fee parameter is preserved.
 *
 *   CSB_RPC_URL=$RPC CSB_CHAIN_ID=8555 CSB_DEPLOYER_KEY=0x... \
 *     npx hardhat run scripts/set-gas-free.js --network csbRemote
 *
 * After this, wallets send zero-priced transactions (see feeOverrides in
 * app/public/common.js), so accounts no longer need tRIEL just to pay gas.
 */
const FEE_MANAGER = "0x0200000000000000000000000000000000000003";
const ABI = [
  "function getFeeConfig() view returns (uint256 gasLimit, uint256 targetBlockRate, uint256 minBaseFee, uint256 targetGas, uint256 baseFeeChangeDenominator, uint256 minBlockGasCost, uint256 maxBlockGasCost, uint256 blockGasCostStep)",
  "function setFeeConfig(uint256 gasLimit, uint256 targetBlockRate, uint256 minBaseFee, uint256 targetGas, uint256 baseFeeChangeDenominator, uint256 minBlockGasCost, uint256 maxBlockGasCost, uint256 blockGasCostStep)",
];

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  const fm = new ethers.Contract(FEE_MANAGER, ABI, deployer);

  const c = await fm.getFeeConfig();
  console.log(`Current minBaseFee: ${ethers.formatUnits(c.minBaseFee, "gwei")} gwei`);
  if (c.minBaseFee === 0n) {
    console.log("Gas is already free (minBaseFee = 0). Nothing to do.");
    return;
  }

  // Pay for THIS transaction at the current (still non-zero) price.
  const block = await ethers.provider.getBlock("latest");
  const base = block?.baseFeePerGas ?? 0n;
  const fees = {
    maxFeePerGas: base * 3n + ethers.parseUnits("500", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("2", "gwei"),
  };

  const tx = await fm.setFeeConfig(
    c.gasLimit, c.targetBlockRate, 0n, c.targetGas,
    c.baseFeeChangeDenominator, c.minBlockGasCost, c.maxBlockGasCost, c.blockGasCostStep,
    fees,
  );
  console.log(`setFeeConfig(minBaseFee=0) … tx ${tx.hash}`);
  await tx.wait();

  const after = await fm.getFeeConfig();
  console.log(`New minBaseFee: ${ethers.formatUnits(after.minBaseFee, "gwei")} gwei — gas is now free.`);
  console.log("Wallets will send zero-priced txs; accounts no longer need tRIEL for gas.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
