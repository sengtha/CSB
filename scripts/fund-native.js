const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Fund the existing pilot accounts with native gas token (tRIEL).
 *
 * Why this exists: the wallet's "Send payment" button submits a real EVM
 * transaction (`KHRStablecoin.transfer`). The node reserves
 * `maxFeePerGas * gasLimit` from the sender's NATIVE balance up front — a pilot
 * account holding KHRt but zero tRIEL cannot pass that check. This mints a
 * little tRIEL to each pilot account via the Native Minter precompile (the
 * deployer is its admin).
 *
 * Nonce & fee handling: earlier runs could leave under-priced deployer
 * transactions stuck pending in the mempool. Because ethers otherwise grabs the
 * next "pending" nonce, every new tx just queues BEHIND the stuck one and never
 * mines. So we drive nonces EXPLICITLY starting from the latest *mined* nonce
 * and price each tx far above the current base fee — that REPLACES any stuck tx
 * at those nonces and unblocks the queue. Receipts are polled with a timeout so
 * nothing hangs.
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
  const provider = ethers.provider;
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  const deployments = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();

  const target = ethers.parseEther(process.env.CSB_FUND_AMOUNT ?? "10");

  // --- chain / mempool diagnostics ---------------------------------------
  const block = await provider.getBlock("latest");
  const baseFee = block?.baseFeePerGas ?? 0n;
  const minedNonce = await provider.getTransactionCount(deployer.address, "latest");
  const pendingNonce = await provider.getTransactionCount(deployer.address, "pending");

  console.log(`Deployer: ${deployer.address}`);
  console.log(`Deployer native balance: ${ethers.formatEther(await provider.getBalance(deployer.address))} tRIEL`);
  console.log(`Current base fee: ${ethers.formatUnits(baseFee, "gwei")} gwei`);
  console.log(`Nonce: mined=${minedNonce} pending=${pendingNonce}` +
    (pendingNonce > minedNonce ? `  → ${pendingNonce - minedNonce} stuck tx(s) will be replaced` : ""));

  // Liveness: is the chain actually producing blocks? If not, no fee helps —
  // the validator needs restarting (see docs/deployment-status.md).
  const n1 = await provider.getBlockNumber();
  await sleep(4000);
  const n2 = await provider.getBlockNumber();
  console.log(`Block height: ${n1} → ${n2} (${n2 > n1 ? "advancing" : "NOT advancing"})`);
  if (n2 === n1) {
    console.log("\n⚠ The chain is not producing new blocks. No transaction can mine until the");
    console.log("  validator is producing again. On the VM:");
    console.log("    avalanche node local list        # find the node name");
    console.log("    avalanche node local start <name>");
    console.log("  Then re-run this script.");
    // We still submit below in case block production resumes shortly, but warn first.
  }

  // Price high enough to REPLACE any earlier stuck attempt (those used up to
  // ~575 gwei). Overpaying is harmless — the node charges only the real base
  // fee, and the deployer holds ~1,000,000 tRIEL.
  const fees = {
    maxFeePerGas: baseFee * 20n + ethers.parseUnits("3000", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("500", "gwei"),
  };
  console.log(`Pricing txs at maxFeePerGas ${ethers.formatUnits(fees.maxFeePerGas, "gwei")} gwei, ` +
    `priority ${ethers.formatUnits(fees.maxPriorityFeePerGas, "gwei")} gwei`);
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

  // Submit all funding txs first, driving nonces explicitly from the latest
  // MINED nonce so we overwrite anything stuck. Then poll for receipts.
  let nonce = minedNonce;
  const submitted = [];
  for (const r of recipients) {
    const bal = await provider.getBalance(r.address);
    if (bal >= target) {
      console.log(`  ${r.name} ${r.address} — already ${ethers.formatEther(bal)} tRIEL, skipping`);
      continue;
    }
    const need = target - bal;
    const opts = { ...fees, nonce: nonce++ };
    const tx = canMint
      ? await minter.mintNativeCoin(r.address, need, opts)
      : await deployer.sendTransaction({ to: r.address, value: need, ...opts });
    console.log(`  ${r.name} ${r.address} — ${canMint ? "mint" : "send"} ${ethers.formatEther(need)} tRIEL @ nonce ${opts.nonce} … tx ${tx.hash}`);
    submitted.push({ r, hash: tx.hash });
  }

  if (submitted.length === 0) {
    console.log("\nAll accounts already funded. Nothing to do.");
    return;
  }

  console.log("\nWaiting for confirmations…");
  let allMined = true;
  for (const s of submitted) {
    const receipt = await waitWithTimeout(provider, s.hash, 120_000);
    if (receipt) {
      console.log(`  ✓ ${s.r.name} mined in block ${receipt.blockNumber}`);
    } else {
      allMined = false;
      console.log(`  ⏳ ${s.r.name} not mined within 120s — tx ${s.hash}`);
    }
  }

  if (allMined) {
    console.log("\nDone. Pilot accounts can now pay gas; reload the wallet and Send payment will work.");
  } else {
    console.log("\nSome txs did not confirm. If block height was NOT advancing above, restart the");
    console.log("validator node, then re-run. Otherwise re-run to bump the fee and replace them.");
    process.exitCode = 1;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Poll for the receipt (the Hardhat provider implements getTransactionReceipt
// but not waitForTransaction). Return null after `ms` so a stuck tx never hangs.
async function waitWithTimeout(provider, hash, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const receipt = await provider.getTransactionReceipt(hash);
    if (receipt) return receipt;
    await sleep(2000);
  }
  return null;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
