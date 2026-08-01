const { ethers } = require("ethers");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Deploy an ICTT `ERC20TokenHome` by hand, when the CLI will not.
 *
 *   node scripts/deploy-token-home.js
 *   CSB_HOME_TOKEN=0x… CSB_HOME_KEY_NAME=fuji-home node scripts/deploy-token-home.js
 *
 * Environment, all with defaults:
 *   CSB_HOME_TOKEN        ERC-20 to wrap        (default Fuji USDC)
 *   CSB_HOME_KEY_NAME     avalanche-cli key     (default "fuji-home")
 *   CSB_TELEPORTER_REGISTRY  ICM registry       (default: read from the relayer config)
 *   CSB_ICTT_ARTIFACT     Foundry artifact      (default: the CLI's own checkout)
 *   CSB_FUJI_RPC          RPC                   (default Fuji C-Chain)
 *   CSB_MIN_TELEPORTER_VERSION                  (default 1)
 *   CSB_DRY_RUN=1         estimate and stop, sending nothing
 *
 * WHY THIS EXISTS. `avalanche interchain tokenTransferrer deploy` failed with
 * `failure deploying ERC20 Home: exceeds block gas limit` against a C-Chain whose
 * block limit is 32,000,000 — roughly eight times what this deployment needs. A
 * deployment does not accidentally ask for 32M gas. That message is go-ethereum's
 * txpool rejecting `tx.Gas() > blockGasLimit`, and the ordinary way a sane deploy
 * produces it is that `eth_estimateGas` FAILED and the caller fell back to a maximum.
 * The interesting failure is therefore hidden behind a gas error that names the wrong
 * thing entirely.
 *
 * So this script's real job is not deploying — it is refusing to hide the reason.
 * It checks the registry answers before using it, estimates gas explicitly, and
 * reports the revert reason when estimation fails instead of substituting a number
 * and letting the txpool produce a misleading complaint.
 *
 * It uses the artifacts avalanche-cli already downloaded and compiled, so the
 * bytecode is the same one the CLI would have deployed — this changes how the
 * transaction is built, not what is in it.
 */

const FUJI = process.env.CSB_FUJI_RPC ?? "https://api.avax-test.network/ext/bc/C/rpc";
const DEFAULT_TOKEN = "0x5425890298aed601595a70AB815c96711a31Bc65";   // Fuji USDC
const CLI_HOME = path.join(os.homedir(), ".avalanche-cli");
const DEFAULT_ARTIFACT = path.join(
  CLI_HOME, "repos", "icm-contracts", "contracts", "out",
  "ERC20TokenHome.sol", "ERC20TokenHome.json");
const DEFAULT_RELAYER_CONFIG = path.join(
  CLI_HOME, "runs", "Fuji", "local-relayer", "icm-relayer-config.json");

/**
 * `latestVersion` is a PUBLIC STATE VARIABLE on `TeleporterRegistry`, so the getter
 * is `latestVersion()`. It is not `getLatestVersion()` — that name appears in
 * docs/fuji-ictt.md and is wrong. Calling the wrong one reverts with no data, which
 * looks exactly like "this is not a registry" and produces a confident, false
 * accusation against a perfectly good contract. Verified against
 * ava-labs/icm-contracts `contracts/teleporter/registry/TeleporterRegistry.sol:51`.
 */
const REGISTRY_ABI = ["function latestVersion() view returns (uint256)"];
const TOKEN_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

function loadKey(name) {
  const p = path.join(CLI_HOME, "key", `${name}.pk`);
  if (!fs.existsSync(p)) {
    throw new Error(`No key file at ${p}\n  Available: `
      + fs.readdirSync(path.join(CLI_HOME, "key")).join(", "));
  }
  const raw = fs.readFileSync(p, "utf8").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error(`${p} does not contain a 32-byte hex private key.`);
  }
  return raw.startsWith("0x") ? raw : "0x" + raw;
}

/**
 * The registry address is a constructor argument and getting it wrong makes the
 * constructor revert, which is the failure this whole script exists to surface. The
 * relayer config is the authoritative source — `avalanche blockchain describe` shows
 * Fuji's addresses even when describing CSB (docs/fuji-ictt.md §1).
 */
function registryFromRelayerConfig(chainHint = "yH8D7ThNJkxmtkuv2jgBa4P1Rn3Qpr4pPr7QYNfcdoS6k6HWp") {
  const f = process.env.CSB_RELAYER_CONFIG ?? DEFAULT_RELAYER_CONFIG;
  if (!fs.existsSync(f)) return null;
  const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const s of cfg["source-blockchains"] ?? []) {
    if (String(s["blockchain-id"]) !== chainHint) continue;
    return s["teleporter-registry-address"]
      ?? Object.values(s["message-contracts"] ?? {})
        .map((v) => v?.settings?.["teleporter-registry-address"]).find(Boolean) ?? null;
  }
  return null;
}

function loadArtifact(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`No artifact at ${p}\n`
      + `  avalanche-cli compiles these during a tokenTransferrer deploy. Find it:\n`
      + `    find ~/.avalanche-cli -iname 'ERC20TokenHome.json'`);
  }
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  // Foundry writes {abi, bytecode:{object}}; hardhat writes {abi, bytecode}.
  const bytecode = typeof a.bytecode === "string" ? a.bytecode : a.bytecode?.object;
  if (!a.abi || !bytecode) throw new Error(`${p} has no abi/bytecode — not a build artifact.`);
  if (!/^0x[0-9a-fA-F]+$/.test(bytecode) || bytecode.length < 100) {
    throw new Error(`${p} bytecode looks empty. A failed compile can leave a stub behind.`);
  }
  return { abi: a.abi, bytecode };
}

async function main() {
  const token = process.env.CSB_HOME_TOKEN ?? DEFAULT_TOKEN;
  if (!ethers.isAddress(token)) throw new Error(`CSB_HOME_TOKEN is not an address: ${token}`);

  const registry = process.env.CSB_TELEPORTER_REGISTRY ?? registryFromRelayerConfig();
  if (!registry) {
    throw new Error("No ICM registry address. Set CSB_TELEPORTER_REGISTRY, or find it:\n"
      + "  node scripts/check-relayer.js");
  }
  if (!ethers.isAddress(registry)) {
    throw new Error(`CSB_TELEPORTER_REGISTRY is not an address: ${registry}`);
  }

  const { abi, bytecode } = loadArtifact(process.env.CSB_ICTT_ARTIFACT ?? DEFAULT_ARTIFACT);
  const provider = new ethers.JsonRpcProvider(FUJI);
  const wallet = new ethers.Wallet(loadKey(process.env.CSB_HOME_KEY_NAME ?? "fuji-home"), provider);

  const net = await provider.getNetwork();
  const block = await provider.getBlock("latest");
  console.log(`Chain      ${net.chainId}`);
  console.log(`Deployer   ${wallet.address}`);
  console.log(`Balance    ${ethers.formatEther(await provider.getBalance(wallet.address))} AVAX`);
  console.log(`Block gas  ${block.gasLimit.toLocaleString("en-US")}`);
  console.log(`Base fee   ${block.baseFeePerGas ?? 0n} wei\n`);

  // --- check the registry BEFORE using it ----------------------------------
  // TokenHome's constructor calls latestVersion() on this address. If it has no
  // code, or is the wrong contract, the constructor reverts and every downstream
  // symptom is about gas instead.
  if ((await provider.getCode(registry)).length <= 2) {
    throw new Error(`No contract at the ICM registry ${registry} on chain ${net.chainId}.\n`
      + `  This is exactly what makes the constructor revert. Check `
      + `node scripts/check-relayer.js — and note the address for CSB is NOT the one `
      + `for Fuji C-Chain.`);
  }
  let version;
  try {
    version = await new ethers.Contract(registry, REGISTRY_ABI, provider).latestVersion();
  } catch (e) {
    throw new Error(`${registry} has code but does not answer latestVersion() — `
      + `it is not an ICM registry.\n  ${e.shortMessage ?? e.message}`);
  }
  // The constructor's own check, run here so it fails with a sentence rather than
  // as unexplained revert data: require(registry.latestVersion() > 0).
  if (version === 0n) {
    throw new Error(`${registry} is a registry with NO registered Teleporter version. `
      + `The constructor requires latestVersion() > 0 and will revert.`);
  }
  console.log(`ICM registry ${registry}  latest version ${version}`);

  const t = new ethers.Contract(token, TOKEN_ABI, provider);
  const [symbol, decimals] = await Promise.all([
    t.symbol().catch(() => null), t.decimals().then(Number).catch(() => null),
  ]);
  if (decimals === null) throw new Error(`${token} does not answer decimals() — not an ERC-20.`);
  console.log(`Token        ${token}  ${symbol} (${decimals} dp)\n`);

  const minVersion = BigInt(process.env.CSB_MIN_TELEPORTER_VERSION ?? 1);
  if (minVersion > version) {
    throw new Error(`CSB_MIN_TELEPORTER_VERSION ${minVersion} exceeds the registry's `
      + `latest (${version}). The constructor rejects that.`);
  }

  // Build the argument list FROM THE ARTIFACT, not from a signature read elsewhere.
  // avalanche-cli pins its own icm-contracts checkout, and this constructor has
  // changed shape across versions — older ERC20TokenHome took four parameters and
  // read the token's decimals itself, newer takes five. Hardcoding either produces
  // ethers' "invalid overrides parameter", which describes the symptom (a trailing
  // argument that is not an options object) and not the cause.
  const KNOWN = {
    teleporterRegistryAddress: registry,
    teleporterManager: wallet.address,
    minTeleporterVersion: minVersion,
    tokenAddress: token,
    tokenDecimals: decimals,
    // seen in some variants
    feeTokenAddress: token,
    token: token,
  };
  const ctor = abi.find((x) => x.type === "constructor");
  if (!ctor) throw new Error("The artifact's ABI has no constructor entry.");

  const unknown = ctor.inputs.filter((i) => !(i.name in KNOWN));
  if (unknown.length) {
    throw new Error(`This artifact's constructor takes parameters this script does not `
      + `know how to fill: ${unknown.map((i) => `${i.type} ${i.name}`).join(", ")}\n`
      + `  Full signature: (${ctor.inputs.map((i) => `${i.type} ${i.name}`).join(", ")})\n`
      + `  The contract version changed. Add the values rather than guessing an order.`);
  }
  const args = ctor.inputs.map((i) => KNOWN[i.name]);

  console.log(`Constructor (${ctor.inputs.length} args, read from the artifact)`);
  for (const i of ctor.inputs) {
    const extra = i.name === "teleporterManager" ? "   (you — can pause/upgrade config)" : "";
    console.log(`  ${i.name.padEnd(26)} ${KNOWN[i.name]}${extra}`);
  }
  if (!ctor.inputs.some((i) => i.name === "tokenDecimals")) {
    console.log(`\n  NOTE: this version takes no tokenDecimals — it reads ${decimals} from`);
    console.log(`  the token itself. The remote must be given the same value.`);
  }
  console.log("");

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const tx = await factory.getDeployTransaction(...args);

  // --- the part the CLI got wrong ------------------------------------------
  let gas;
  try {
    gas = await provider.estimateGas({ ...tx, from: wallet.address });
  } catch (e) {
    // Report the reason rather than substituting a number. A fallback to some
    // maximum is what turns a constructor revert into "exceeds block gas limit".
    console.error(`\nESTIMATION FAILED — this is the real error, not a gas problem.`);
    console.error(`  ${e.shortMessage ?? e.message}`);
    if (e.data && e.data !== "0x") {
      try {
        const parsed = new ethers.Interface(abi).parseError(e.data);
        console.error(`  decoded: ${parsed?.name}(${parsed?.args?.join(", ")})`);
      } catch { console.error(`  raw revert data: ${e.data}`); }
    }
    console.error(`\n  Most likely: the registry address is wrong for this chain, or its`);
    console.error(`  latest version is below minTeleporterVersion. Both make the`);
    console.error(`  constructor revert, and neither has anything to do with gas.`);
    process.exitCode = 1;
    return;
  }

  const padded = (gas * 120n) / 100n;
  console.log(`Estimated gas ${gas.toLocaleString("en-US")}  (submitting ${padded.toLocaleString("en-US")})`);
  if (padded > block.gasLimit) {
    throw new Error(`Even the padded estimate exceeds the block gas limit. That would be `
      + `a genuine ceiling rather than the CLI's arithmetic — stop and reconsider.`);
  }
  const cost = padded * (block.baseFeePerGas ?? 0n);
  console.log(`Worst-case fee ${ethers.formatEther(cost)} AVAX\n`);

  if (process.env.CSB_DRY_RUN === "1") {
    console.log(`CSB_DRY_RUN=1 — estimated successfully and stopped. Nothing was sent.`);
    return;
  }

  const sent = await factory.deploy(...args, { gasLimit: padded });
  console.log(`Deploying in ${sent.deploymentTransaction().hash} …`);
  await sent.waitForDeployment();
  const addr = await sent.getAddress();

  console.log(`\n${"=".repeat(68)}`);
  console.log(`ERC20TokenHome deployed on chain ${net.chainId}`);
  console.log(`  ${addr}`);
  console.log(`\nThis is the HOME, on Fuji. It is NOT the address CSB needs.`);
  console.log(`Next: deploy the matching ERC20TokenRemote on CSB, then register it.`);
  console.log(`Keep this address — the remote's constructor needs it.`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
