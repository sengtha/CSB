const hre = require("hardhat");

/**
 * Drive the chain's CURRENT base fee down to a target, by producing blocks.
 *
 * Lowering `minBaseFee` with the feeManager only moves the FLOOR. The base fee
 * actually charged decays toward that floor a few percent per block — and
 * Subnet-EVM only builds a block when there is something to put in it. So on an
 * idle chain, lowering the floor changes nothing at all: the base fee sits where
 * it was, and any transaction priced for the new floor is under-priced and hangs
 * forever. Waiting does not help, because waiting produces no blocks.
 *
 * This sends minimal 21,000-gas self-transfers, each priced at the going rate,
 * purely to make blocks so the decay can happen. They cost about 1 tRIEL each.
 *
 *   CSB_TARGET_GWEI=44000 npx hardhat run scripts/settle-base-fee.js --network csbRemote
 *
 * Env:
 *   CSB_TARGET_GWEI   stop once the base fee is at or below this (required)
 *   CSB_MAX_BLOCKS    give up after this many nudges (default 150)
 */
async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();

  const target = ethers.parseUnits(process.env.CSB_TARGET_GWEI ?? "0", "gwei");
  if (target === 0n) throw new Error("Set CSB_TARGET_GWEI to the base fee you need to reach.");
  const maxBlocks = Number(process.env.CSB_MAX_BLOCKS ?? 150);

  const read = async () => (await provider.getBlock("latest"))?.baseFeePerGas ?? 0n;
  let fee = await read();
  console.log(`Base fee now:   ${ethers.formatUnits(fee, "gwei")} gwei`);
  console.log(`Target:         ${ethers.formatUnits(target, "gwei")} gwei`);

  if (fee <= target) {
    console.log("\nAlready at or below target — nothing to do.");
    return;
  }

  console.log(`\nNudging the chain to produce blocks so the fee can decay…`);
  let n = 0;
  let last = fee;
  let stalled = 0;
  while (fee > target && n < maxBlocks) {
    // Price each nudge at the CURRENT fee (plus headroom) so it always mines,
    // whatever the fee has decayed to since the last one.
    const price = (fee * 12n) / 10n;
    try {
      const tx = await signer.sendTransaction({
        to: signer.address, value: 0, gasLimit: 21000, gasPrice: price,
      });
      await tx.wait();
    } catch (e) {
      console.log(`  nudge failed: ${e.shortMessage ?? e.message}`);
      break;
    }
    n++;
    fee = await read();
    if (n % 5 === 0 || fee <= target) {
      console.log(`  ${String(n).padStart(3)} blocks → ${ethers.formatUnits(fee, "gwei")} gwei`);
    }
    // If the fee is not moving, more blocks will not help — say so rather than
    // burning through the whole budget.
    if (fee >= last) {
      if (++stalled >= 5) {
        console.log(`\nBase fee is not decaying (stuck at ${ethers.formatUnits(fee, "gwei")} gwei).`);
        console.log(`It may already be at the floor: lower minBaseFee further with`);
        console.log(`  CSB_GAS_TRIEL=<smaller> npx hardhat run scripts/set-gas-price.js --network csbRemote`);
        process.exitCode = 1;
        return;
      }
    } else {
      stalled = 0;
    }
    last = fee;
  }

  if (fee <= target) {
    console.log(`\nBase fee is ${ethers.formatUnits(fee, "gwei")} gwei after ${n} blocks — ready.`);
  } else {
    console.log(`\nStopped after ${n} blocks at ${ethers.formatUnits(fee, "gwei")} gwei (target ${ethers.formatUnits(target, "gwei")}).`);
    console.log(`Raise CSB_MAX_BLOCKS, or pick a target closer to the current fee.`);
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
