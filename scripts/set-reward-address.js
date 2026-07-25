const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Route ALL gas fees to a single address instead of burning them, via the
 * RewardManager precompile (enabled at genesis precisely so this choice stayed
 * open — see docs/architecture.md §8).
 *
 * Policy: for now every gas fee on CSB goes to the public-good fund. Unlike the
 * KHRt transfer levy, which only applies to KHRt payments, this covers EVERY
 * transaction on the chain — a contract deployment, an NFT mint, a native
 * transfer — because the chain itself hands the fee over at block production.
 * Nothing is asked of the sender and no contract is involved.
 *
 * ILLUSTRATIVE. The default recipient is the demo charity account created by
 * scripts/enable-charity-levy.js as a relatable placeholder. This implies no
 * affiliation with, or endorsement by, any real organisation, and moves
 * valueless test tokens on a testnet only.
 *
 *   CSB_RPC_URL=$RPC CSB_CHAIN_ID=8555 CSB_DEPLOYER_KEY=0x... \
 *     npx hardhat run scripts/set-reward-address.js --network csbRemote
 *
 * Optional env:
 *   CSB_REWARD_ADDR   recipient (default: the charity in app/deployments.json)
 *   CSB_REWARD_MODE   "address" (default) | "burn" | "producers"
 *                       burn      — go back to destroying fees (disableRewards)
 *                       producers — each validator keeps the fees it produces
 */
const REWARD_MANAGER = "0x0200000000000000000000000000000000000004";
const ABI = [
  "function setRewardAddress(address addr)",
  "function currentRewardAddress() view returns (address rewardAddress)",
  "function allowFeeRecipients()",
  "function disableRewards()",
  "function readAllowList(address addr) view returns (uint256)",
];

async function main() {
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();
  const rm = new ethers.Contract(REWARD_MANAGER, ABI, deployer);

  console.log(`Deployer: ${deployer.address}`);

  // The precompile must be enabled at genesis; if it is not, nothing here works.
  let role;
  try {
    role = await rm.readAllowList(deployer.address);
  } catch (_) {
    throw new Error(
      "RewardManager precompile is not available on this chain. It has to be enabled " +
      "in genesis — a running chain cannot add it. Redeploy with rewardManagerConfig set.",
    );
  }
  if (role === 0n) {
    throw new Error(
      `${deployer.address} has no RewardManager role (readAllowList returned 0). ` +
      `An admin must enable it before it can change fee distribution.`,
    );
  }

  const mode = process.env.CSB_REWARD_MODE ?? "address";
  const before = await currentRecipient(rm);
  console.log(`Current fee recipient: ${before}`);

  if (mode === "burn") {
    await send(await rm.disableRewards(), "disableRewards()");
    console.log("\nGas fees are now BURNED (destroyed, reducing tRIEL supply).");
    return;
  }
  if (mode === "producers") {
    await send(await rm.allowFeeRecipients(), "allowFeeRecipients()");
    console.log("\nEach validator now keeps the fees from blocks it produces.");
    return;
  }
  if (mode !== "address") {
    throw new Error(`Unknown CSB_REWARD_MODE "${mode}" — expected address, burn, or producers.`);
  }

  const to = process.env.CSB_REWARD_ADDR ?? charityFromDeployments();
  if (!to) {
    throw new Error(
      "No recipient. Set CSB_REWARD_ADDR, or run scripts/enable-charity-levy.js first " +
      "so a public-good address exists in app/deployments.json.",
    );
  }
  if (!ethers.isAddress(to)) throw new Error(`CSB_REWARD_ADDR "${to}" is not a valid address.`);
  if (to === ethers.ZeroAddress) {
    // setRewardAddress(0) is not a no-op — it is how fees get burned. Make the
    // caller say so explicitly rather than doing it by accident via a typo.
    throw new Error("Refusing to set the zero address. Use CSB_REWARD_MODE=burn to burn fees.");
  }

  if (before.toLowerCase() === to.toLowerCase()) {
    console.log(`\nAlready routing fees to ${to}. Nothing to do.`);
    return;
  }

  await send(await rm.setRewardAddress(to), `setRewardAddress(${to})`);

  const after = await currentRecipient(rm);
  console.log(`\nGas fees now go to: ${after}`);
  console.log(`Balance there: ${ethers.formatEther(await ethers.provider.getBalance(to))} tRIEL`);
  console.log(`\nEvery transaction on the chain now contributes its gas fee to this address —`);
  console.log(`not only KHRt payments, and with nothing extra asked of the sender.`);
  console.log(`Reverse it any time: CSB_REWARD_MODE=burn (destroy) or =producers (validators keep).`);
}

async function send(tx, label) {
  console.log(`${label} … tx ${tx.hash}`);
  await tx.wait();
}

async function currentRecipient(rm) {
  try {
    return await rm.currentRewardAddress();
  } catch (_) {
    return "(none — fees are burned or paid to block producers)";
  }
}

function charityFromDeployments() {
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  if (!fs.existsSync(file)) return null;
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  return d.pilot?.charity?.address ?? null;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
