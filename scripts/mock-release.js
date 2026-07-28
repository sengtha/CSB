const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Return tokens escrowed in MockBridgeAdapter back to a holder.
 *
 *   source ops/csb-env.sh
 *   CSB_RELEASE_TO=0x… [CSB_RELEASE_AMOUNT=100] \
 *     npx hardhat run scripts/mock-release.js --network csbRemote
 *
 * WHY THIS EXISTS. MockBridgeAdapter is the development stand-in for the real
 * ICTT adapter: it takes the tokens, emits BridgeSend, and stops there. On a
 * chain where the gateway has not yet been repointed at a real adapter, an
 * egress request therefore looks completely successful — Transfer and
 * EgressInitiated both fire, the sender's balance drops — and nothing crosses to
 * Fuji, because there is nothing on the other side. The tokens sit in the mock.
 *
 * That is a devnet stub behaving correctly, not a bug, but it is indistinguishable
 * from a working bridge unless you check which adapter the gateway holds. Someone
 * who bridges from the website before running scripts/wire-ictt.js will hit it,
 * and the honest answer to "where did my tokens go" needs to come with the
 * command that gets them back.
 *
 * `release` is onlyOwner (the council). The recipient must be KYC-active on
 * KHRt, exactly as for any other transfer — releasing to a non-KYC'd address
 * reverts on compliance, which is the system working.
 */
async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = d.contracts ?? {};
  const [signer] = await ethers.getSigners();

  const mock = c.MockBridgeAdapter;
  const khrAddr = c.KHRStablecoin;
  if (!mock) throw new Error("No MockBridgeAdapter in deployments.json — nothing to release from.");

  const to = process.env.CSB_RELEASE_TO;
  if (!to || !ethers.isAddress(to)) throw new Error("Set CSB_RELEASE_TO=0x… (must be KYC-active on KHRt).");

  const khr = new ethers.Contract(khrAddr, [
    "function balanceOf(address) view returns (uint256)",
    "function identity() view returns (address)",
    "function enforcement() view returns (address)",
  ], ethers.provider);

  const held = await khr.balanceOf(mock);
  console.log(`MockBridgeAdapter ${mock}`);
  console.log(`  holds ${(Number(held) / 100).toFixed(2)} KHRt`);
  if (held === 0n) {
    console.log("Nothing escrowed here. If you expected tokens, check which adapter the");
    console.log("gateway actually points at:  gateway.policies(<KHRt>)");
    return;
  }

  const amount = process.env.CSB_RELEASE_AMOUNT
    ? BigInt(Math.round(Number(process.env.CSB_RELEASE_AMOUNT) * 100))
    : held;
  if (amount > held) throw new Error(`Asked for ${Number(amount) / 100} but only ${Number(held) / 100} is escrowed.`);

  // Check the recipient BEFORE sending. KHRt enforces KYC on every transfer, so
  // releasing to an unverified or frozen address reverts with a custom error
  // that reads as a broken script rather than as policy doing its job.
  // KYC and freezes live in different registries because they are different
  // powers (P3) — ask both.
  const registry = new ethers.Contract(await khr.identity(), [
    "function isActive(address) view returns (bool)",
  ], ethers.provider);
  const enforcement = new ethers.Contract(await khr.enforcement(), [
    "function isFrozen(address) view returns (bool)",
  ], ethers.provider);
  const [verified, frozen] = await Promise.all([
    registry.isActive(to).catch(() => null),
    enforcement.isFrozen(to).catch(() => null),
  ]);
  if (verified === false) throw new Error(`${to} is not KYC-verified — KHRt cannot be transferred to it.`);
  if (frozen === true) throw new Error(`${to} is frozen — unfreeze it first (Admin -> Enforcement).`);

  const adapter = new ethers.Contract(mock, [
    "function release(address token, address to, uint256 amount)",
    "function owner() view returns (address)",
  ], signer);

  const owner = await adapter.owner();
  if (owner.toLowerCase() !== signer.address.toLowerCase()) {
    throw new Error(`release() is onlyOwner. Owner is ${owner}, signing as ${signer.address}.`);
  }

  console.log(`\nReleasing ${(Number(amount) / 100).toFixed(2)} KHRt to ${to}…`);
  const tx = await adapter.release(khrAddr, to, amount);
  console.log(`  tx ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  ✓ block ${rc.blockNumber}`);
  console.log(`  recipient now holds ${(Number(await khr.balanceOf(to)) / 100).toFixed(2)} KHRt`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
