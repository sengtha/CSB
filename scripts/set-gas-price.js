const hre = require("hardhat");

/**
 * Policy: a transaction costs about 1 tRIEL (= 1 riel).
 *
 * Set the fee floor so that a REFERENCE transaction costs the target amount, via
 * the feeManager precompile (deployer is admin).
 *
 * An important limitation to understand before using this: the EVM charges
 * `gasPrice x gasUsed`, so a chain CANNOT price every transaction at a flat
 * 1 tRIEL. What it can do is fix the price per unit of gas. We pick that price
 * so the reference transaction lands on the target, and everything else costs in
 * proportion to the work it does — a plain transfer is cheapest, a contract call
 * costs more, a deployment more again. The script prints the resulting price of
 * common operations so the real schedule is visible rather than assumed.
 *
 * If you want a genuinely flat per-payment fee regardless of complexity, that
 * belongs at the contract layer, not the fee config — see RielPay's levy and
 * KHRt's transferLevy, which charge a fixed amount per payment.
 *
 *   CSB_RPC_URL=$RPC CSB_CHAIN_ID=8555 CSB_DEPLOYER_KEY=0x... \
 *     npx hardhat run scripts/set-gas-price.js --network csbRemote
 *
 * Optional env:
 *   CSB_GAS_TRIEL     target cost of the reference tx, in tRIEL (default "1")
 *   CSB_GAS_REF_GAS   reference gas amount (default "21000", a plain transfer)
 *   CSB_KEEP_BLOCK_COST=1  don't zero the block gas cost (see below)
 */
const FEE_MANAGER = "0x0200000000000000000000000000000000000003";
const ABI = [
  "function getFeeConfig() view returns (uint256 gasLimit, uint256 targetBlockRate, uint256 minBaseFee, uint256 targetGas, uint256 baseFeeChangeDenominator, uint256 minBlockGasCost, uint256 maxBlockGasCost, uint256 blockGasCostStep)",
  "function setFeeConfig(uint256 gasLimit, uint256 targetBlockRate, uint256 minBaseFee, uint256 targetGas, uint256 baseFeeChangeDenominator, uint256 minBlockGasCost, uint256 maxBlockGasCost, uint256 blockGasCostStep)",
];

// Representative gas costs, for the price table below.
const OPERATIONS = [
  ["Native tRIEL transfer", 21_000n],
  ["KHRt transfer", 65_000n],
  ["KHRt transfer with public-good levy", 100_000n],
  ["RielPay payment", 60_000n],
  ["Wrap tokenized riel → tRIEL", 120_000n],
  ["Contract deployment (typical)", 1_500_000n],
];

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  const fm = new ethers.Contract(FEE_MANAGER, ABI, deployer);

  const targetTriel = process.env.CSB_GAS_TRIEL ?? "1";
  const refGas = BigInt(process.env.CSB_GAS_REF_GAS ?? "21000");
  const targetWei = ethers.parseEther(targetTriel);
  const price = targetWei / refGas; // wei per gas

  if (price === 0n) {
    throw new Error(
      `Target ${targetTriel} tRIEL over ${refGas} gas rounds to a price of 0 wei/gas. ` +
      `That is free gas — use scripts/set-gas-free.js if that is what you want.`,
    );
  }

  const c = await fm.getFeeConfig();
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Current minBaseFee: ${ethers.formatUnits(c.minBaseFee, "gwei")} gwei`);
  console.log(`Target: ${targetTriel} tRIEL per ${refGas} gas`);
  console.log(`      → ${ethers.formatUnits(price, "gwei")} gwei per gas\n`);

  // The base fee only sits ON the floor if nothing pushes it above. Subnet-EVM
  // adds a per-block "gas cost" surcharge that a block producer must cover, and
  // that is what has kept this chain's effective fee well above minBaseFee
  // before. Zero it so the advertised price is the price actually charged.
  const keepBlockCost = process.env.CSB_KEEP_BLOCK_COST === "1";
  const minBlockGasCost = keepBlockCost ? c.minBlockGasCost : 0n;
  const maxBlockGasCost = keepBlockCost ? c.maxBlockGasCost : 0n;
  const blockGasCostStep = keepBlockCost ? c.blockGasCostStep : 0n;
  if (!keepBlockCost && (c.maxBlockGasCost > 0n || c.blockGasCostStep > 0n)) {
    console.log(`Zeroing block gas cost (was max=${c.maxBlockGasCost}, step=${c.blockGasCostStep})`);
    console.log(`so the effective fee stays at the floor. CSB_KEEP_BLOCK_COST=1 to preserve it.\n`);
  }

  const tx = await fm.setFeeConfig(
    c.gasLimit, c.targetBlockRate, price, c.targetGas,
    c.baseFeeChangeDenominator, minBlockGasCost, maxBlockGasCost, blockGasCostStep,
  );
  console.log(`setFeeConfig(minBaseFee=${price}) … tx ${tx.hash}`);
  await tx.wait();

  const after = await fm.getFeeConfig();
  console.log(`New minBaseFee: ${ethers.formatUnits(after.minBaseFee, "gwei")} gwei\n`);

  console.log("What this costs in practice:");
  for (const [label, gas] of OPERATIONS) {
    const cost = after.minBaseFee * gas;
    console.log(`  ${label.padEnd(38)} ~${fmtRiel(ethers, cost)}`);
  }

  console.log(`\nNote: the fee is per unit of gas, so only a ${refGas}-gas transaction costs`);
  console.log(`exactly ${targetTriel} tRIEL. Heavier transactions cost proportionally more.`);
  console.log(`For a flat per-payment charge, use the contract-level levy instead.`);

  // Anything submitting at a lower price than the new floor will now sit unmined.
  const configured = BigInt(process.env.CSB_GAS_PRICE_WEI ?? "500000000000");
  if (configured <= after.minBaseFee) {
    const suggested = (after.minBaseFee * 11n) / 10n;
    console.log(`\n⚠ hardhat's configured gasPrice (${ethers.formatUnits(configured, "gwei")} gwei) is now BELOW`);
    console.log(`  the fee floor — scripts would submit under-priced txs that never mine. Use:`);
    console.log(`     export CSB_GAS_PRICE_WEI=${suggested}`);
    console.log(`  (the committed default in hardhat.config.js has been raised to match this policy.)`);
  }
}

function fmtRiel(ethers, wei) {
  const s = ethers.formatEther(wei);
  return `${Number(s).toLocaleString(undefined, { maximumFractionDigits: 4 })} tRIEL`;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
