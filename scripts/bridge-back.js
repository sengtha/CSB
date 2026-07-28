const { ethers } = require("ethers");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Bridge KHRt back: Fuji C-Chain → CSB.
 *
 *   CSB_TOKEN_REMOTE=0x…        \  # ERC20TokenRemote on Fuji (the bridged token)
 *   CSB_TOKEN_HOME=0x…          \  # ERC20TokenHome on CSB (holds the collateral)
 *   CSB_HOME_BLOCKCHAIN_ID=0x…  \  # CSB blockchain ID, 32-byte hex
 *   CSB_BACK_TO=0x…             \  # recipient on CSB — MUST be KYC-active
 *   CSB_BACK_AMOUNT=100         \  # KHRt, decimal
 *   [CSB_REMOTE_KEY_NAME=csb-deployer] \
 *     node scripts/bridge-back.js
 *
 * HOW THE RETURN PATH WORKS. The token on Fuji is not KHRt; it is
 * ERC20TokenRemote, a separate ERC-20 minted when collateral was locked on CSB.
 * `send()` burns the caller's balance of it and emits an ICM message. When a
 * relayer delivers that message to CSB, the TokenHome releases the equivalent
 * KHRt to the recipient. No approve() is needed — the remote burns its own
 * token, it does not pull one.
 *
 * THE CHECK THAT MATTERS. KHRt enforces KYC on every transfer, and the TokenHome
 * releasing collateral is a transfer like any other. If the CSB recipient is not
 * KYC-active, the delivery reverts ON CSB — after the Fuji-side burn has already
 * succeeded. The tokens are not lost (the message can be re-delivered once the
 * recipient is verified, and the collateral stays in the Home either way), but
 * the failure happens on a different chain from the transaction you sent, hours
 * of confusion away from its cause. So this reads the CSB identity registry
 * BEFORE burning anything, and refuses if the recipient cannot receive.
 *
 * That asymmetry is the whole design: leaving the sovereign perimeter is
 * council-governed and visible; coming back is subject to the same KYC rule as
 * any domestic transfer. A bridge cannot be used to launder an identity.
 */
const FUJI_C = process.env.CSB_FUJI_RPC ?? "https://api.avax-test.network/ext/bc/C/rpc";
const REQUIRED_GAS_LIMIT = BigInt(process.env.CSB_BACK_GAS_LIMIT ?? 250000);

function loadKey(name) {
  const p = path.join(os.homedir(), ".avalanche-cli", "key", `${name}.pk`);
  if (!fs.existsSync(p)) throw new Error(`No key file at ${p} — check CSB_REMOTE_KEY_NAME.`);
  const raw = fs.readFileSync(p, "utf8").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${p} does not contain a 32-byte hex private key.`);
  return raw.startsWith("0x") ? raw : "0x" + raw;
}

const need = (k, test, hint) => {
  const v = process.env[k];
  if (!v || (test && !test(v))) throw new Error(`${k} is required${hint ? ` — ${hint}` : ""}.`);
  return v;
};

async function main() {
  const remoteAddr = need("CSB_TOKEN_REMOTE", ethers.isAddress, "the ERC20TokenRemote on Fuji");
  const homeAddr = need("CSB_TOKEN_HOME", ethers.isAddress, "the ERC20TokenHome on CSB");
  const homeChainId = need("CSB_HOME_BLOCKCHAIN_ID", (v) => /^0x[0-9a-fA-F]{64}$/.test(v),
    "CSB's blockchain ID as 32-byte hex");
  const to = need("CSB_BACK_TO", ethers.isAddress, "the recipient on CSB");
  const keyName = process.env.CSB_REMOTE_KEY_NAME ?? "csb-deployer";

  // --- can the recipient actually receive on CSB? --------------------------
  // Done first, and against CSB rather than Fuji, because this is the failure
  // that would otherwise surface on the far side of the bridge.
  const csbRpc = process.env.CSB_RPC_URL;
  if (!csbRpc) throw new Error("CSB_RPC_URL is not set — run: source ops/csb-env.sh");
  const csb = new ethers.JsonRpcProvider(csbRpc);
  const depFile = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const khrAddr = JSON.parse(fs.readFileSync(depFile, "utf8")).contracts?.KHRStablecoin;
  if (!khrAddr) throw new Error("KHRStablecoin missing from deployments.json");

  const khr = new ethers.Contract(khrAddr, [
    "function identity() view returns (address)",
    "function enforcement() view returns (address)",
    "function balanceOf(address) view returns (uint256)",
  ], csb);
  // KYC lives in IdentityRegistry, freezes in EnforcementRegistry. They are
  // separate contracts because they are separate powers (P3), so checking the
  // recipient means asking both.
  const registry = new ethers.Contract(await khr.identity(), [
    "function isActive(address) view returns (bool)",
  ], csb);
  const enforcement = new ethers.Contract(await khr.enforcement(), [
    "function isFrozen(address) view returns (bool)",
  ], csb);
  const [verified, frozen] = await Promise.all([
    registry.isActive(to).catch(() => null),
    enforcement.isFrozen(to).catch(() => null),
  ]);
  console.log(`CSB recipient ${to}  verified=${verified} frozen=${frozen}`);
  if (verified === false) {
    throw new Error(
      `${to} is not KYC-verified on CSB. The Fuji burn would succeed and the CSB\n`
      + `  delivery would revert. Approve it in Admin first.`);
  }
  if (frozen === true) throw new Error(`${to} is frozen on CSB — unfreeze it first.`);

  const homeHolds = await khr.balanceOf(homeAddr);
  console.log(`TokenHome collateral ${(Number(homeHolds) / 100).toFixed(2)} KHRt`);

  // --- Fuji side -----------------------------------------------------------
  const provider = new ethers.JsonRpcProvider(FUJI_C);
  const wallet = new ethers.Wallet(loadKey(keyName), provider);
  const remote = new ethers.Contract(remoteAddr, [
    "function balanceOf(address) view returns (uint256)",
    "function decimals() view returns (uint8)",
    "function send((bytes32 destinationBlockchainID, address destinationTokenTransferrerAddress, address recipient, address primaryFeeTokenAddress, uint256 primaryFee, uint256 secondaryFee, uint256 requiredGasLimit, address multiHopFallback) input, uint256 amount)",
  ], wallet);

  // Read decimals from the remote rather than assuming KHRt's 2. ICTT can be
  // configured with a different scale on the remote side, and getting this wrong
  // silently sends 100x or 1/100th of the intended amount.
  const decimals = Number(await remote.decimals());
  const amount = ethers.parseUnits(process.env.CSB_BACK_AMOUNT ?? "100", decimals);
  const bal = await remote.balanceOf(wallet.address);

  console.log(`Fuji sender   ${wallet.address}  (${keyName})`);
  console.log(`  bridged token ${remoteAddr}  decimals=${decimals}`);
  console.log(`  balance ${ethers.formatUnits(bal, decimals)}`);
  console.log(`  sending ${ethers.formatUnits(amount, decimals)} back to CSB`);
  if (bal < amount) throw new Error("Sender does not hold that much of the bridged token.");
  if (homeHolds < BigInt(amount)) {
    console.log(`  NOTE: the Home holds less collateral than this. Delivery will revert`);
    console.log(`        on CSB until the Home is collateralised for this amount.`);
  }

  console.log("\nSending…");
  const tx = await remote.send({
    destinationBlockchainID: homeChainId,
    destinationTokenTransferrerAddress: homeAddr,
    recipient: to,
    primaryFeeTokenAddress: ethers.ZeroAddress,
    primaryFee: 0n,
    secondaryFee: 0n,
    requiredGasLimit: REQUIRED_GAS_LIMIT,
    multiHopFallback: ethers.ZeroAddress,
  }, amount);
  console.log(`  tx ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  ✓ mined in Fuji block ${rc.blockNumber}`);

  console.log("\nThe bridged token is burned on Fuji and an ICM message is on its way.");
  console.log("A relayer must deliver it before the KHRt appears on CSB. Check with:");
  console.log(`  avalanche interchain relayer logs`);
  console.log(`  then the recipient's KHRt balance on CSB.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
