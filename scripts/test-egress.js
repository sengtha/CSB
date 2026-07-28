const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * End-to-end test of the CSB -> Fuji egress path, run AFTER scripts/wire-ictt.js.
 *
 *   source ops/csb-env.sh
 *   CSB_EGRESS_FROM=sokha \            # pilot account key name, or a raw 0x private key
 *   CSB_EGRESS_AMOUNT=100 \            # KHRt, decimal (100 = 100.00 riel)
 *   CSB_EGRESS_RECIPIENT=0x… \         # 20-byte address on Fuji C-Chain
 *     npx hardhat run scripts/test-egress.js --network csbRemote
 *
 * What this checks, in order, and why each one is here:
 *
 *   1. The gateway's policy for KHRt actually points at the REAL adapter, not
 *      MockBridgeAdapter. Wiring is easy to half-finish, and a mock adapter
 *      "succeeds" locally while nothing ever reaches Fuji — the most misleading
 *      possible outcome of a bridge test.
 *   2. The sender is KYC-active, unfrozen, and at or above the policy's minimum
 *      tier. Checked BEFORE sending, because the revert reasons (TierTooLow,
 *      NotKycActive, AccountFrozen) are custom errors that most tooling renders
 *      as an unreadable selector.
 *   3. Allowance and balance.
 *   4. The send itself, decoding EgressInitiated from the receipt.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: confirm arrival on Fuji. That depends on a
 * relayer this script does not control, and pretending otherwise would report
 * success for a transfer whose tokens are sitting locked in the TokenHome. It
 * prints what to check on the Fuji side instead.
 */
async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = d.contracts ?? {};
  const provider = ethers.provider;

  const gatewayAddr = c.EgressGateway;
  const khrAddr = c.KHRStablecoin;
  if (!gatewayAddr || !khrAddr) throw new Error("EgressGateway/KHRStablecoin missing from deployments.json");

  // --- who is sending ------------------------------------------------------
  const fromSpec = process.env.CSB_EGRESS_FROM ?? "sokha";
  let sender;
  if (/^0x[0-9a-fA-F]{64}$/.test(fromSpec)) {
    sender = new ethers.Wallet(fromSpec, provider);
  } else {
    const cast = d.pilot?.accounts ?? d.accounts ?? {};
    const acct = cast[fromSpec];
    if (!acct?.key) {
      throw new Error(
        `No key for "${fromSpec}" in ${path.basename(file)}. Available: `
        + (Object.keys(cast).join(", ") || "(none — the pilot cast is missing)")
        + "\n  — or pass a raw 0x private key in CSB_EGRESS_FROM.");
    }
    sender = new ethers.Wallet(acct.key, provider);
  }

  const amount = BigInt(Math.round(Number(process.env.CSB_EGRESS_AMOUNT ?? "100") * 100));
  const recipient = process.env.CSB_EGRESS_RECIPIENT;
  if (!recipient || !ethers.isAddress(recipient)) {
    throw new Error("CSB_EGRESS_RECIPIENT must be a 20-byte address on Fuji C-Chain");
  }
  const destLabel = process.env.CSB_DEST_LABEL ?? "avalanche-c-chain";
  const destKey = ethers.id(destLabel);

  console.log(`Sender     ${sender.address}  (${fromSpec})`);
  console.log(`Amount     ${(Number(amount) / 100).toFixed(2)} KHRt`);
  console.log(`To         ${recipient} on "${destLabel}"`);
  console.log();

  const gateway = new ethers.Contract(gatewayAddr, [
    // The auto-generated getter for `mapping(address => TokenPolicy) public
    // policies`. Named `policies`, not `tokenPolicy` — guessing the latter
    // produced a bare "missing revert data" against a live gateway, which reads
    // like a broken contract rather than a wrong ABI.
    "function policies(address) view returns (bool allowed, uint8 minTier, uint256 dailyCap, address adapter)",
    "function requestEgress(address token, uint256 amount, bytes32 destinationChain, bytes recipient)",
    "function paused() view returns (bool)",
    "event EgressInitiated(address indexed token, address indexed from, bytes32 indexed destinationChain, uint256 amount, bytes recipient)",
  ], sender);
  const khr = new ethers.Contract(khrAddr, [
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
    "function identity() view returns (address)",
    "function enforcement() view returns (address)",
  ], sender);

  // --- 1. is the policy pointing at a REAL adapter? ------------------------
  let policy;
  try {
    policy = await gateway.policies(khrAddr);
  } catch (e) {
    throw new Error(`Could not read the gateway's KHRt policy — is ${gatewayAddr} an EgressGateway? (${e.shortMessage ?? e.message})`);
  }
  const [allowed, minTier, dailyCap, adapter] = policy;
  console.log(`Policy     allowed=${allowed} minTier=${minTier} dailyCap=${(Number(dailyCap) / 100).toFixed(2)} adapter=${adapter}`);

  if (!allowed) throw new Error("KHRt egress is not permitted by the gateway. Run scripts/wire-ictt.js.");
  if (adapter === ethers.ZeroAddress) throw new Error("No adapter set. Run scripts/wire-ictt.js.");

  const mock = c.MockBridgeAdapter;
  if (mock && adapter.toLowerCase() === mock.toLowerCase()) {
    // The whole point of this check. A mock adapter makes every step below pass
    // and nothing arrives on Fuji, which reads as a relayer problem for hours.
    throw new Error(
      "The gateway is still pointed at MockBridgeAdapter. This would 'succeed' "
      + "and send nothing to Fuji.\nRun scripts/wire-ictt.js with the real "
      + "TokenHome/TokenRemote first.");
  }
  if (await gateway.paused()) throw new Error("The gateway is paused (Admin -> pause).");

  // --- 2. is the sender allowed to bridge? ---------------------------------
  // KYC lives in IdentityRegistry and freezes in EnforcementRegistry — separate
  // contracts because they are separate powers (identity issuance vs. asset
  // seizure), so the sender's eligibility takes two calls, not one.
  const registry = new ethers.Contract(await khr.identity(), [
    "function isActive(address) view returns (bool)",
    "function tierOf(address) view returns (uint8)",
  ], provider);
  const enforcement = new ethers.Contract(await khr.enforcement(), [
    "function isFrozen(address) view returns (bool)",
  ], provider);
  const [verified, tier, frozen] = await Promise.all([
    registry.isActive(sender.address).catch(() => null),
    registry.tierOf(sender.address).catch(() => null),
    enforcement.isFrozen(sender.address).catch(() => null),
  ]);
  console.log(`Sender KYC verified=${verified} tier=${tier} frozen=${frozen}`);
  if (verified === false) throw new Error(`${sender.address} is not KYC-verified — approve it in Admin.`);
  if (frozen === true) throw new Error(`${sender.address} is frozen — unfreeze it in Admin -> Enforcement.`);
  if (tier != null && Number(tier) < Number(minTier)) {
    throw new Error(`Sender tier ${tier} is below the policy minimum ${minTier}. Raise the tier in Admin.`);
  }

  // --- 3. balance and allowance -------------------------------------------
  const bal = await khr.balanceOf(sender.address);
  console.log(`Balance    ${(Number(bal) / 100).toFixed(2)} KHRt`);
  if (bal < amount) throw new Error(`Balance is below the amount being sent.`);

  const gasBal = await provider.getBalance(sender.address);
  console.log(`Gas        ${ethers.formatEther(gasBal)} tRIEL`);
  if (gasBal === 0n) throw new Error("Sender has no tRIEL for gas — gas is about 1 riel per transaction.");

  if (await khr.allowance(sender.address, gatewayAddr) < amount) {
    console.log("\nApproving the gateway…");
    const a = await khr.approve(gatewayAddr, amount);
    await a.wait();
    console.log(`  ✓ ${a.hash}`);
  }

  // --- 4. send -------------------------------------------------------------
  console.log("\nRequesting egress…");
  const tx = await gateway.requestEgress(khrAddr, amount, destKey, recipient);
  console.log(`  tx ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  ✓ block ${rc.blockNumber}, gas ${rc.gasUsed} @ ${rc.gasPrice} wei`
    + ` = ${ethers.formatEther(rc.gasUsed * rc.gasPrice)} tRIEL`);

  const ev = rc.logs
    .map((l) => { try { return gateway.interface.parseLog(l); } catch { return null; } })
    .find((p) => p && p.name === "EgressInitiated");
  if (ev) {
    console.log(`  EgressInitiated: ${(Number(ev.args.amount) / 100).toFixed(2)} KHRt -> ${ev.args.recipient}`);
  } else {
    console.log("  (no EgressInitiated event decoded — check the adapter wiring)");
  }

  console.log(`\nCollateral is now LOCKED in the TokenHome on CSB.`);
  console.log(`Arrival on Fuji depends on the relayer, which this script does not check.`);
  console.log(`Confirm it actually crossed:`);
  console.log(`  - the relayer's log should show a message delivered for this block`);
  console.log(`  - balance of ${recipient} on the ERC20TokenRemote, on Fuji C-Chain`);
  console.log(`If the balance stays 0 with no relayer error, the send worked and delivery did not.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
