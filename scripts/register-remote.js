const { ethers } = require("ethers");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Make an already-deployed ERC20TokenRemote register itself with its TokenHome.
 *
 *   node scripts/register-remote.js 0xRemoteAddress            # remote on Fuji
 *   CSB_REGISTER_ON=csb node scripts/register-remote.js 0x…    # remote on CSB
 *
 * WORKS IN BOTH DIRECTIONS. The KHRt bridge puts the remote on Fuji; the bridged
 * dollar puts it on CSB. Registration always runs on whichever chain the REMOTE is
 * deployed to, so `CSB_REGISTER_ON=csb` switches the RPC, the signing key and the
 * gas handling together — getting one of those right and another wrong is how this
 * ends up as a transaction that never mines.
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
const ON_CSB = (process.env.CSB_REGISTER_ON ?? "").toLowerCase() === "csb";

function loadKey(name) {
  const p = path.join(os.homedir(), ".avalanche-cli", "key", `${name}.pk`);
  if (!fs.existsSync(p)) throw new Error(`No key file at ${p} — check CSB_REMOTE_KEY_NAME.`);
  const raw = fs.readFileSync(p, "utf8").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${p} does not contain a 32-byte hex private key.`);
  return raw.startsWith("0x") ? raw : "0x" + raw;
}

async function main() {
  const remoteAddr = process.argv[2] ?? process.env.CSB_TOKEN_REMOTE;
  if (!remoteAddr || !ethers.isAddress(remoteAddr)) {
    throw new Error("Pass the ERC20TokenRemote address:\n"
      + "  node scripts/register-remote.js 0xRemoteAddress\n"
      + "  (add CSB_REGISTER_ON=csb when the remote is on CSB rather than Fuji)");
  }

  // Which chain the REMOTE is on decides everything else.
  let rpc, wallet, label, unit, provider, overrides = {};
  if (ON_CSB) {
    rpc = process.env.CSB_RPC_URL;
    if (!rpc || !process.env.CSB_DEPLOYER_KEY) {
      throw new Error("CSB_REGISTER_ON=csb needs `source ops/csb-env.sh` first.");
    }
    provider = new ethers.JsonRpcProvider(rpc);
    wallet = new ethers.Wallet(process.env.CSB_DEPLOYER_KEY, provider);
    label = "CSB";
    unit = "tRIEL";
    // CSB's fee floor is far above what ethers estimates from a quiet chain, and an
    // under-priced transaction is ACCEPTED and then never mined — which looks like
    // the bridge hanging rather than like a fee problem. Same reason
    // hardhat.config.js pins a gas price for this chain.
    overrides = { gasPrice: BigInt(process.env.CSB_GAS_PRICE_WEI ?? 55_000_000_000_000) };
  } else {
    rpc = FUJI_C;
    provider = new ethers.JsonRpcProvider(rpc);
    const keyName = process.env.CSB_REMOTE_KEY_NAME ?? "ewoq";
    wallet = new ethers.Wallet(loadKey(keyName), provider);
    label = `Fuji C-Chain (${keyName})`;
    unit = "AVAX";
  }

  console.log(`${label.padEnd(12)} ${rpc}`);
  console.log(`Signer       ${wallet.address}`);

  const code = await provider.getCode(remoteAddr);
  if (code.length <= 2) {
    throw new Error(`No contract at ${remoteAddr} on ${label}.\n`
      + `  Registration runs on the chain the REMOTE is deployed to. If the remote is `
      + `on CSB, add CSB_REGISTER_ON=csb.`);
  }
  console.log(`Remote       ${remoteAddr}  (${code.length / 2 - 1} bytes)`);

  const bal = await provider.getBalance(wallet.address);
  console.log(`Balance      ${ethers.formatEther(bal)} ${unit}`);
  if (bal === 0n) throw new Error(`Signer has no ${unit} for gas.`);

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
  const tx = await remote.registerWithHome(
    { feeTokenAddress: ethers.ZeroAddress, amount: 0n }, overrides);
  console.log(`  tx ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  ✓ mined in block ${rc.blockNumber}`);

  const from = ON_CSB ? "CSB" : "Fuji";
  const to = ON_CSB ? "Fuji" : "CSB";
  console.log(`\nThat sent an ICM message from ${from} to ${to}. A relayer must deliver it.`);
  console.log("Confirm it landed by looking for a new event on the TokenHome:");
  console.log("  the Home should gain a RemoteRegistered event within a minute or two.");
  console.log(`If nothing appears, the relayer is not delivering ${from} -> ${to} —`);
  console.log("check `avalanche interchain relayer logs`.");
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
