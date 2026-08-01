const { ethers } = require("ethers");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Deploy the matching ICTT `ERC20TokenRemote` on CSB, when the CLI will not.
 *
 *   source ops/csb-env.sh
 *   node scripts/deploy-token-remote.js 0xHomeAddressOnFuji
 *
 * Environment:
 *   (argv[1])             the ERC20TokenHome on Fuji — simplest, paste-proof
 *   CSB_TOKEN_HOME        same, as an environment variable
 *                         (falls back to bridgeHomes.<key>.address in deployments.json)
 *   CSB_HOME_BLOCKCHAIN_ID  32-byte hex of the home chain  (default Fuji C-Chain)
 *   CSB_HOME_DECIMALS     decimals of the home token                    (default 6)
 *   CSB_REMOTE_NAME       ERC-20 name on CSB          (default "Bridged USD Coin")
 *   CSB_REMOTE_SYMBOL     ERC-20 symbol on CSB                    (default "USDC")
 *   CSB_REMOTE_DECIMALS   decimals on CSB                (default: same as home)
 *   CSB_TELEPORTER_REGISTRY  CSB's ICM registry   (default: from relayer config)
 *   CSB_ICTT_ARTIFACT     Foundry artifact           (default: the CLI's checkout)
 *   CSB_DRY_RUN=1         estimate and stop, sending nothing
 *
 * The companion to scripts/deploy-token-home.js, and it exists for the same reason:
 * `avalanche interchain tokenTransferrer deploy` computed a gas value that the txpool
 * rejected, reporting it as a block-gas-limit problem on a chain with eight times the
 * needed headroom. This builds the transaction with a real `eth_estimateGas` and
 * reports the revert reason when estimation fails rather than substituting a number.
 *
 * TWO REGISTRIES, AND USING THE WRONG ONE IS THE EASIEST MISTAKE HERE. The home's
 * constructor took FUJI's ICM registry; this one takes CSB's. They are different
 * addresses, and `avalanche blockchain describe csb` prints Fuji's while describing
 * CSB (docs/fuji-ictt.md §1). The default is read from the relayer config, which is
 * authoritative.
 *
 * WHAT THIS DOES NOT DO: register the remote with its home. That is a separate
 * transaction on this chain whose ICM message travels back to Fuji, and
 * scripts/register-remote.js already does it. Deploy first, register second.
 */

const CLI_HOME = path.join(os.homedir(), ".avalanche-cli");
const DEFAULT_ARTIFACT = path.join(
  CLI_HOME, "repos", "icm-contracts", "contracts", "out",
  "ERC20TokenRemote.sol", "ERC20TokenRemote.json");
const DEFAULT_RELAYER_CONFIG = path.join(
  CLI_HOME, "runs", "Fuji", "local-relayer", "icm-relayer-config.json");

// CSB's blockchain ID, CB58, as recorded in docs/fuji-ictt.md.
const CSB_CB58 = "299jCTH4ErmwFMB3ZKa18Ck9EDzc99DMD48zkszxcArpaUfTqW";
// Fuji C-Chain's blockchain ID in hex — what the remote stores as its home.
const FUJI_C_HEX = "0x7fc93d85c6d62c5b2ac0b519c87010ea5294012d1e407030d6acd0021cac10d5";

const REGISTRY_ABI = ["function latestVersion() view returns (uint256)"];

function registryForCSB() {
  const f = process.env.CSB_RELAYER_CONFIG ?? DEFAULT_RELAYER_CONFIG;
  if (!fs.existsSync(f)) return null;
  const cfg = JSON.parse(fs.readFileSync(f, "utf8"));
  for (const s of cfg["source-blockchains"] ?? []) {
    if (String(s["blockchain-id"]) !== CSB_CB58) continue;
    return s["teleporter-registry-address"]
      ?? Object.values(s["message-contracts"] ?? {})
        .map((v) => v?.settings?.["teleporter-registry-address"]).find(Boolean) ?? null;
  }
  return null;
}

function loadArtifact(p) {
  if (!fs.existsSync(p)) {
    throw new Error(`No artifact at ${p}\n`
      + `  Find it: find ~/.avalanche-cli -iname 'ERC20TokenRemote.json'`);
  }
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  const bytecode = typeof a.bytecode === "string" ? a.bytecode : a.bytecode?.object;
  if (!a.abi || !bytecode) throw new Error(`${p} has no abi/bytecode — not a build artifact.`);
  if (!/^0x[0-9a-fA-F]+$/.test(bytecode) || bytecode.length < 100) {
    throw new Error(`${p} bytecode looks empty. A failed compile can leave a stub behind.`);
  }
  return { abi: a.abi, bytecode };
}

async function main() {
  const bridgeKey = process.env.CSB_BRIDGED_KEY ?? "usdc";
  const rpc = process.env.CSB_RPC_URL;
  const key = process.env.CSB_DEPLOYER_KEY;
  if (!rpc || !key) throw new Error("Run `source ops/csb-env.sh` first — CSB_RPC_URL "
    + "and CSB_DEPLOYER_KEY are not set.");

  // Three ways to supply it, in order, because a multi-line env-var invocation is
  // easy to mangle on paste and the resulting "not undefined" says nothing useful:
  // an argument, the environment, or the record deploy-token-home.js wrote.
  const recorded = (() => {
    try {
      const f = process.env.CSB_DEPLOYMENTS_FILE
        ?? path.join(__dirname, "..", "app", "deployments.json");
      return JSON.parse(fs.readFileSync(f, "utf8")).bridgeHomes?.[bridgeKey]?.address ?? null;
    } catch { return null; }
  })();
  const home = process.argv[2] ?? process.env.CSB_TOKEN_HOME ?? recorded;
  if (!home || !ethers.isAddress(home)) {
    throw new Error(`No ERC20TokenHome address (got ${JSON.stringify(home)}).\n`
      + `  Pass it as an argument — simplest, and survives copy-paste:\n`
      + `    node scripts/deploy-token-remote.js 0xYourHomeAddress\n`
      + `  Or set CSB_TOKEN_HOME. scripts/deploy-token-home.js prints it on success `
      + `and records it in deployments.json, from which this reads automatically.`);
  }

  const registry = process.env.CSB_TELEPORTER_REGISTRY ?? registryForCSB();
  if (!registry || !ethers.isAddress(registry)) {
    throw new Error("No CSB ICM registry address. Set CSB_TELEPORTER_REGISTRY, or:\n"
      + "  node scripts/check-relayer.js   (take the CSB one, NOT Fuji's)");
  }

  const homeChain = process.env.CSB_HOME_BLOCKCHAIN_ID ?? FUJI_C_HEX;
  if (!/^0x[0-9a-fA-F]{64}$/.test(homeChain)) {
    throw new Error(`CSB_HOME_BLOCKCHAIN_ID must be 32-byte hex, not ${homeChain}. `
      + `The CB58 form the CLI shows is a different encoding.`);
  }

  const homeDecimals = Number(process.env.CSB_HOME_DECIMALS ?? 6);
  const remoteDecimals = Number(process.env.CSB_REMOTE_DECIMALS ?? homeDecimals);
  const name = process.env.CSB_REMOTE_NAME ?? "Bridged USD Coin";
  const symbol = process.env.CSB_REMOTE_SYMBOL ?? "USDC";

  const { abi, bytecode } = loadArtifact(process.env.CSB_ICTT_ARTIFACT ?? DEFAULT_ARTIFACT);
  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(key, provider);

  const net = await provider.getNetwork();
  const block = await provider.getBlock("latest");
  console.log(`Chain      ${net.chainId}  (CSB)`);
  console.log(`Deployer   ${wallet.address}`);
  console.log(`Balance    ${ethers.formatEther(await provider.getBalance(wallet.address))} tRIEL`);
  console.log(`Block gas  ${block.gasLimit.toLocaleString("en-US")}\n`);

  if ((await provider.getCode(registry)).length <= 2) {
    throw new Error(`No contract at ${registry} on CSB. This is CSB's ICM registry — `
      + `Fuji's address will NOT have code here, and mixing them up is the usual cause.`);
  }
  const version = await new ethers.Contract(registry, REGISTRY_ABI, provider).latestVersion()
    .catch(() => { throw new Error(`${registry} does not answer latestVersion() on CSB.`); });
  if (version === 0n) throw new Error(`${registry} has no registered Teleporter version.`);
  console.log(`CSB ICM registry ${registry}  latest version ${version}`);
  console.log(`Home on Fuji     ${home}`);
  console.log(`Home chain       ${homeChain}\n`);

  // Values by canonical parameter name, flattened across the settings struct.
  const VALUES = {
    teleporterRegistryAddress: registry,
    teleporterManager: wallet.address,
    minTeleporterVersion: BigInt(process.env.CSB_MIN_TELEPORTER_VERSION ?? 1),
    tokenHomeBlockchainID: homeChain,
    tokenHomeAddress: home,
    tokenHomeDecimals: homeDecimals,
    tokenName: name,
    tokenSymbol: symbol,
    tokenDecimals: remoteDecimals,
  };
  const canon = (n) => n.replace(/_+$/, "");

  const ctor = abi.find((x) => x.type === "constructor");
  if (!ctor) throw new Error("The artifact's ABI has no constructor entry.");

  // The remote's settings arrive as a STRUCT in most versions and as flat arguments
  // in others, so resolve tuples component-wise rather than assuming either.
  const missing = [];
  const resolve = (input) => {
    if (input.type === "tuple") {
      return input.components.map((c) => {
        if (!(canon(c.name) in VALUES)) { missing.push(`${c.type} ${input.name}.${c.name}`); return null; }
        return VALUES[canon(c.name)];
      });
    }
    if (!(canon(input.name) in VALUES)) { missing.push(`${input.type} ${input.name}`); return null; }
    return VALUES[canon(input.name)];
  };
  const args = ctor.inputs.map(resolve);
  if (missing.length) {
    throw new Error(`This artifact's constructor takes parameters this script does not `
      + `know how to fill: ${missing.join(", ")}\n`
      + `  Full signature: (${ctor.inputs.map((i) => i.type === "tuple"
        ? `(${i.components.map((c) => `${c.type} ${c.name}`).join(", ")}) ${i.name}`
        : `${i.type} ${i.name}`).join(", ")})`);
  }

  console.log(`Constructor (read from the artifact)`);
  for (const i of ctor.inputs) {
    if (i.type === "tuple") {
      console.log(`  ${i.name} {`);
      for (const c of i.components) console.log(`    ${c.name.padEnd(24)} ${VALUES[canon(c.name)]}`);
      console.log(`  }`);
    } else {
      console.log(`  ${i.name.padEnd(26)} ${VALUES[canon(i.name)]}`);
    }
  }
  console.log("");

  const factory = new ethers.ContractFactory(abi, bytecode, wallet);
  const tx = await factory.getDeployTransaction(...args);

  let gas;
  try {
    gas = await provider.estimateGas({ ...tx, from: wallet.address });
  } catch (e) {
    console.error(`\nESTIMATION FAILED — this is the real error, not a gas problem.`);
    console.error(`  ${e.shortMessage ?? e.message}`);
    if (e.data && e.data !== "0x") {
      try {
        const parsed = new ethers.Interface(abi).parseError(e.data);
        console.error(`  decoded: ${parsed?.name}(${parsed?.args?.join(", ")})`);
      } catch { console.error(`  raw revert data: ${e.data}`); }
    }
    console.error(`\n  Most likely: the wrong ICM registry (Fuji's instead of CSB's), or`);
    console.error(`  a home blockchain ID in the wrong encoding.`);
    process.exitCode = 1;
    return;
  }

  const padded = (gas * 120n) / 100n;
  console.log(`Estimated gas ${gas.toLocaleString("en-US")}  (submitting ${padded.toLocaleString("en-US")})`);
  if (padded > block.gasLimit) throw new Error(`Padded estimate exceeds CSB's block gas limit.`);

  if (process.env.CSB_DRY_RUN === "1") {
    console.log(`\nCSB_DRY_RUN=1 — estimated successfully and stopped. Nothing was sent.`);
    return;
  }

  // The deployer must be on contractDeployerAllowList or this reverts at execution
  // rather than being rejected, which reads as a contract fault.
  const sent = await factory.deploy(...args, { gasLimit: padded });
  console.log(`Deploying in ${sent.deploymentTransaction().hash} …`);
  await sent.waitForDeployment();
  const addr = await sent.getAddress();

  console.log(`\n${"=".repeat(68)}`);
  console.log(`ERC20TokenRemote deployed on CSB`);
  console.log(`  ${addr}`);
  console.log(`\nIt is NOT yet registered with its home, so nothing can bridge yet.`);
  console.log(`Registration runs on the chain the remote is on — CSB, here:`);
  console.log(`  CSB_REGISTER_ON=csb node scripts/register-remote.js ${addr}`);
  console.log(`\nThen record it:`);
  console.log(`  CSB_BRIDGED_TOKEN=${addr} CSB_EXPECT_SYMBOL=${symbol} \\`);
  console.log(`    npx hardhat run scripts/usdc-ingress.js --network csbRemote`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
