const { ethers } = require("ethers");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Make an already-deployed ERC20TokenRemote register itself with its TokenHome.
 *
 *   CSB_TOKEN_REMOTE=0x… \
 *   [CSB_FUJI_RPC=https://api.avax-test.network/ext/bc/C/rpc] \
 *   [CSB_REMOTE_KEY_NAME=ewoq] \
 *     node scripts/register-remote.js
 *
 * WHY THIS IS SEPARATE FROM THE DEPLOY. `avalanche interchain tokenTransferrer
 * deploy` deploys both halves and then calls registerWithHome() on the remote.
 * That call sends an ICM message from the remote chain back to the home chain,
 * so it only completes if a relayer is running — and the natural order of
 * operations is to deploy the pair first and start the relayer afterwards. The
 * deploy then ends with "timeout waiting for remote endpoint registration",
 * having successfully deployed two contracts that do not know about each other.
 *
 * Re-running the deploy would work, but it deploys a SECOND remote and leaves
 * the first orphaned. Registration is idempotent and cheap; re-registering an
 * existing remote is the smaller, clearer operation.
 *
 * This runs against the REMOTE chain (Fuji C-Chain), not CSB, so it does not use
 * hardhat's csbRemote network. It reads the signing key from the avalanche-cli
 * keystore rather than taking it on the command line, so the key never lands in
 * shell history.
 */
const FUJI_C = process.env.CSB_FUJI_RPC ?? "https://api.avax-test.network/ext/bc/C/rpc";

function loadKey(name) {
  const p = path.join(os.homedir(), ".avalanche-cli", "key", `${name}.pk`);
  if (!fs.existsSync(p)) throw new Error(`No key file at ${p} — check CSB_REMOTE_KEY_NAME.`);
  const raw = fs.readFileSync(p, "utf8").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${p} does not contain a 32-byte hex private key.`);
  return raw.startsWith("0x") ? raw : "0x" + raw;
}

async function main() {
  const remoteAddr = process.env.CSB_TOKEN_REMOTE;
  if (!remoteAddr || !ethers.isAddress(remoteAddr)) {
    throw new Error("Set CSB_TOKEN_REMOTE=0x… (the ERC20TokenRemote on Fuji C-Chain).");
  }
  const keyName = process.env.CSB_REMOTE_KEY_NAME ?? "ewoq";

  const provider = new ethers.JsonRpcProvider(FUJI_C);
  const wallet = new ethers.Wallet(loadKey(keyName), provider);
  console.log(`Fuji C-Chain ${FUJI_C}`);
  console.log(`Signer       ${wallet.address}  (${keyName})`);

  const code = await provider.getCode(remoteAddr);
  if (code.length <= 2) throw new Error(`No contract at ${remoteAddr} on Fuji C-Chain.`);
  console.log(`Remote       ${remoteAddr}  (${code.length / 2 - 1} bytes)`);

  const bal = await provider.getBalance(wallet.address);
  console.log(`Balance      ${ethers.formatEther(bal)} AVAX`);
  if (bal === 0n) throw new Error("Signer has no Fuji AVAX for gas.");

  const remote = new ethers.Contract(remoteAddr, [
    "function registerWithHome((address feeTokenAddress, uint256 amount) feeInfo)",
    "function isRegistered() view returns (bool)",
  ], wallet);

  // Not every ICTT version exposes isRegistered(); treat a failure to read it as
  // unknown rather than as "not registered", and go ahead either way. Sending a
  // duplicate registration is harmless; skipping a needed one is not.
  try {
    console.log(`Registered   ${await remote.isRegistered()}`);
  } catch {
    console.log(`Registered   (this ICTT version does not expose isRegistered)`);
  }

  console.log("\nSending registerWithHome…");
  const tx = await remote.registerWithHome({ feeTokenAddress: ethers.ZeroAddress, amount: 0n });
  console.log(`  tx ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  ✓ mined in block ${rc.blockNumber}`);

  console.log("\nThat sent an ICM message from Fuji to CSB. A relayer must deliver it.");
  console.log("Confirm it landed by looking for a new event on the TokenHome:");
  console.log("  the Home should gain a RemoteRegistered event within a minute or two.");
  console.log("If nothing appears, the relayer is not delivering C-Chain -> csb —");
  console.log("check `avalanche interchain relayer logs`.");
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
