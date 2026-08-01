const { ethers } = require("ethers");
const fs = require("fs");
const os = require("os");
const path = require("path");

/**
 * Send a bridged asset from Fuji INTO CSB.
 *
 *   node scripts/bridge-in.js 25            # 25 USDC to the deployer on CSB
 *   node scripts/bridge-in.js 25 0xRecipientOnCSB
 *
 * Environment, all with defaults:
 *   CSB_TOKEN_HOME        the Home on Fuji — only if not yet recorded; then remembered
 *   CSB_HOME_TOKEN        the token it wraps                     (default Fuji USDC)
 *   CSB_HOME_KEY_NAME     avalanche-cli key that holds the USDC   (default "fuji-home")
 *   CSB_BRIDGED_KEY       which deployments.json entry to use          (default "usdc")
 *   CSB_REQUIRED_GAS      gas the delivery may use on CSB            (default 350000)
 *   CSB_DRY_RUN=1         check everything, send nothing
 *
 * THE COUNTERPART TO scripts/bridge-back.js, which moves KHRt out. This moves a
 * foreign asset in, and the asymmetry between the two is the architecture's whole
 * position on the boundary: leaving is council-governed and capped, while arriving is
 * governed by nothing (docs/architecture.md §7.1).
 *
 * WHICH MAKES THE RECIPIENT CHECK THE IMPORTANT PART OF THIS SCRIPT. On this path
 * there is no compliance gate to refuse a bad delivery, and no `forcedTransfer` to
 * undo one, because the arriving token is a contract we did not write. So a mis-sent
 * transfer is permanent in a way an equivalent KHRt mistake is not. The check that
 * matters is therefore not identity but `txAllowList`: an address that cannot
 * transact on CSB can RECEIVE this token and then do nothing with it at all — no
 * spend, no bridge-out, no delegation, since each needs a transaction it cannot
 * submit. That is a permanent loss, and it is the failure this script exists to
 * prevent rather than to report afterwards.
 *
 * THE BURN AND THE DELIVERY ARE ON DIFFERENT CHAINS. `send()` locks the token in the
 * Home on Fuji and emits an ICM message; the tokens appear on CSB only when a relayer
 * delivers it. A successful transaction here is therefore NOT proof of arrival, and
 * the script says so rather than implying the job is done.
 */

const FUJI = process.env.CSB_FUJI_RPC ?? "https://api.avax-test.network/ext/bc/C/rpc";
const CLI_HOME = path.join(os.homedir(), ".avalanche-cli");
const DEFAULT_ARTIFACT = path.join(
  CLI_HOME, "repos", "icm-contracts", "contracts", "out",
  "ERC20TokenHome.sol", "ERC20TokenHome.json");
// CSB's blockchain ID in hex — where the tokens are going.
const CSB_HEX = process.env.CSB_BLOCKCHAIN_ID_HEX
  ?? "0x9633e7227257f4de7dcd8e595bfafdd8cf6f88918926dd1d4e2ddfff46978a61";

const DEFAULT_FUJI_USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";
const TX_ALLOWLIST = "0x0200000000000000000000000000000000000002";
const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

function loadKey(name) {
  const p = path.join(CLI_HOME, "key", `${name}.pk`);
  if (!fs.existsSync(p)) throw new Error(`No key file at ${p}`);
  const raw = fs.readFileSync(p, "utf8").trim();
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) throw new Error(`${p} is not a 32-byte hex key.`);
  return raw.startsWith("0x") ? raw : "0x" + raw;
}

function loadArtifact(p) {
  if (!fs.existsSync(p)) throw new Error(`No artifact at ${p}`);
  const a = JSON.parse(fs.readFileSync(p, "utf8"));
  const bytecode = typeof a.bytecode === "string" ? a.bytecode : a.bytecode?.object;
  if (!a.abi) throw new Error(`${p} has no abi.`);
  return { abi: a.abi, bytecode };
}

async function main() {
  const amountArg = process.argv[2];
  if (!amountArg || !/^[0-9]*\.?[0-9]+$/.test(amountArg)) {
    throw new Error("Pass the amount to bridge:\n  node scripts/bridge-in.js 25 [0xRecipient]");
  }

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  let d;
  try {
    d = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read ${file}: ${e.message}\n`
      + `  This script needs the recorded Home and remote addresses. Set `
      + `CSB_DEPLOYMENTS_FILE if yours is elsewhere.`);
  }
  const key = process.env.CSB_BRIDGED_KEY ?? "usdc";
  const remoteRec = d.bridged?.[key];
  if (!remoteRec?.address) throw new Error(`No bridged.${key} in deployments.json — `
    + `run scripts/usdc-ingress.js first.`);

  // A Home deployed before this record existed will not be in the file. Accept it
  // from the environment and WRITE IT BACK, so the gap closes itself rather than
  // needing the same two variables on every future run.
  let homeRec = d.bridgeHomes?.[key];
  const envHome = process.env.CSB_TOKEN_HOME;
  const envToken = process.env.CSB_HOME_TOKEN;
  if (envHome || !homeRec?.address) {
    const address = envHome ?? homeRec?.address;
    const tokenAddr = envToken ?? homeRec?.token ?? DEFAULT_FUJI_USDC;
    if (!address || !ethers.isAddress(address)) {
      throw new Error(`No Home address. It is not recorded in deployments.json — a Home `
        + `deployed before that record existed will not be — so supply it once:\n`
        + `    CSB_TOKEN_HOME=0xYourHomeOnFuji node scripts/bridge-in.js ${amountArg}\n`
        + `  It will be written to deployments.json and not needed again.`);
    }
    if (!ethers.isAddress(tokenAddr)) {
      throw new Error(`CSB_HOME_TOKEN is not an address: ${tokenAddr}`);
    }
    homeRec = { ...(homeRec ?? {}), address, token: tokenAddr };
    d.bridgeHomes = { ...(d.bridgeHomes ?? {}), [key]: homeRec };
    try {
      fs.writeFileSync(file, JSON.stringify(d, null, 2));
      console.log(`Recorded bridgeHomes.${key} = ${address} in ${path.basename(file)}\n`);
    } catch (e) {
      console.log(`Could not record the Home (${e.message}) — pass CSB_TOKEN_HOME again next time.\n`);
    }
  }

  const fuji = new ethers.JsonRpcProvider(FUJI);
  const wallet = new ethers.Wallet(loadKey(process.env.CSB_HOME_KEY_NAME ?? "fuji-home"), fuji);
  const recipient = process.argv[3] ?? d.roles?.council ?? wallet.address;
  if (!ethers.isAddress(recipient)) throw new Error(`Recipient is not an address: ${recipient}`);

  const token = new ethers.Contract(homeRec.token, ERC20_ABI, wallet);
  const decimals = Number(await token.decimals());
  const symbol = await token.symbol().catch(() => key.toUpperCase());
  const amount = ethers.parseUnits(amountArg, decimals);

  console.log(`Fuji C-Chain`);
  console.log(`  sender     ${wallet.address}`);
  console.log(`  token      ${homeRec.token}  ${symbol}`);
  console.log(`  home       ${homeRec.address}`);
  console.log(`  amount     ${amountArg} ${symbol}\n`);
  console.log(`CSB`);
  console.log(`  remote     ${remoteRec.address}`);
  console.log(`  recipient  ${recipient}\n`);

  // --- the check that prevents a permanent loss ----------------------------
  const csbRpc = process.env.CSB_RPC_URL;
  if (!csbRpc) {
    console.log(`  WARNING: CSB_RPC_URL is not set, so the recipient's ability to`);
    console.log(`  transact on CSB was NOT checked. Run \`source ops/csb-env.sh\` first.`);
    console.log(`  Sending to an address that cannot transact loses the tokens for good.`);
  } else {
    const csb = new ethers.JsonRpcProvider(csbRpc);
    const role = await new ethers.Contract(TX_ALLOWLIST,
      ["function readAllowList(address) view returns (uint256)"], csb)
      .readAllowList(recipient).then(Number).catch(() => null);
    const NAMES = { 0: "none", 1: "enabled", 2: "admin", 3: "manager" };
    console.log(`  recipient txAllowList role on CSB: ${role === null ? "unreadable" : NAMES[role]}`);
    if (role === 0) {
      throw new Error(`REFUSING TO SEND. ${recipient} is not on CSB's txAllowList, so it `
        + `could receive these tokens and never move them — no spend, no bridge-out, no `
        + `delegation, because each needs a transaction it cannot submit.\n`
        + `  There is no forcedTransfer on this token to undo it. The loss is permanent.\n`
        + `  Admit the address first:\n`
        + `    CSB_DEV_ADDR=${recipient} npx hardhat run scripts/allow-dev.js --network csbRemote`);
    }
    // DO NOT ask the remote whether it is registered. TokenRemote.isRegistered() is
    // "set to true when the first message is received from the home contract" — so it
    // stays FALSE after registration completes, until the first transfer arrives. An
    // earlier version of this script refused to send until it was true, which is a
    // deadlock: the transfer being blocked is the one that would set it.
    //
    // The home is the authority. It records the remote when the REGISTER_REMOTE
    // message is delivered, and that is what must be true before sending.
    const remoteFlag = await new ethers.Contract(remoteRec.address,
      ["function isRegistered() view returns (bool)"], csb).isRegistered().catch(() => null);
    console.log(`  remote isRegistered() (false until first transfer): ${remoteFlag}`);
  }

  // --- ask the HOME, on Fuji, whether it knows this remote ------------------
  {
    const { abi: homeAbi } = loadArtifact(process.env.CSB_ICTT_ARTIFACT ?? DEFAULT_ARTIFACT);
    const hasGetter = homeAbi.some((x) => x.type === "function"
      && x.name === "getRemoteTokenTransferrerSettings");
    if (!hasGetter) {
      console.log(`  home registration: cannot check — this ICTT version has no `
        + `getRemoteTokenTransferrerSettings()`);
    } else {
      const settings = await new ethers.Contract(homeRec.address, homeAbi, fuji)
        .getRemoteTokenTransferrerSettings(CSB_HEX, remoteRec.address).catch(() => null);
      if (settings === null) {
        console.log(`  home registration: unreadable`);
      } else {
        console.log(`  home has registered this remote:   ${settings.registered}`);
        if (settings.collateralNeeded > 0n) {
          console.log(`  collateral still needed:           `
            + `${ethers.formatUnits(settings.collateralNeeded, decimals)} ${symbol}`);
          console.log(`  (the first sends go to collateral, NOT to the recipient)`);
        }
        if (!settings.registered) {
          throw new Error(`The home does not know this remote yet, so a transfer would `
            + `have nowhere to be delivered.\n`
            + `  Either registerWithHome() has not been called, or its ICM message has `
            + `not been delivered from CSB to Fuji:\n`
            + `    CSB_REGISTER_ON=csb node scripts/register-remote.js ${remoteRec.address}\n`
            + `  If it was called, check the relayer is carrying CSB -> Fuji.`);
        }
      }
    }
  }

  // Balance last of the three. Being short is recoverable in a way that sending to
  // an address which cannot transact is not, so the destination is checked first and
  // reported even when there is nothing to send.
  const bal = await token.balanceOf(wallet.address);
  if (bal < amount) {
    throw new Error(`Sender holds ${ethers.formatUnits(bal, decimals)} ${symbol}, `
      + `needs ${amountArg}.`);
  }

  // --- build SendTokensInput from the artifact's own struct ----------------
  const { abi } = loadArtifact(process.env.CSB_ICTT_ARTIFACT ?? DEFAULT_ARTIFACT);
  const sendFn = abi.find((x) => x.type === "function" && x.name === "send");
  if (!sendFn) throw new Error("The Home artifact's ABI has no send() function.");
  const struct = sendFn.inputs.find((i) => i.type === "tuple");
  if (!struct) throw new Error("send() does not take a struct — unexpected ICTT shape.");

  const requiredGas = BigInt(process.env.CSB_REQUIRED_GAS ?? 350_000);
  const VALUES = {
    destinationBlockchainID: CSB_HEX,
    destinationTokenTransferrerAddress: remoteRec.address,
    recipient,
    primaryFeeTokenAddress: ethers.ZeroAddress,
    primaryFee: 0n,
    secondaryFee: 0n,
    requiredGasLimit: requiredGas,
    multiHopFallback: ethers.ZeroAddress,
  };
  const canon = (n) => n.replace(/_+$/, "");
  const missing = struct.components.filter((c) => !(canon(c.name) in VALUES));
  if (missing.length) {
    throw new Error(`SendTokensInput has fields this script does not fill: `
      + `${missing.map((c) => `${c.type} ${c.name}`).join(", ")}`);
  }
  const input = struct.components.map((c) => VALUES[canon(c.name)]);

  console.log(`\n  requiredGasLimit ${requiredGas} (gas the delivery may use on CSB)`);

  if (process.env.CSB_DRY_RUN === "1") {
    console.log(`\nCSB_DRY_RUN=1 — all checks passed, nothing sent.`);
    return;
  }

  const allowance = await token.allowance(wallet.address, homeRec.address);
  if (allowance < amount) {
    console.log(`\nApproving the Home to move ${amountArg} ${symbol}…`);
    await (await token.approve(homeRec.address, amount)).wait();
  }

  const home = new ethers.Contract(homeRec.address, abi, wallet);
  console.log(`Sending…`);
  const tx = await home.send(input, amount);
  console.log(`  tx ${tx.hash}`);
  const rc = await tx.wait();
  console.log(`  ✓ mined on Fuji in block ${rc.blockNumber}`);

  console.log(`\nTHE TOKENS ARE NOT ON CSB YET. That transaction locked them in the Home`);
  console.log(`and emitted an ICM message; a relayer has to deliver it. Check in a minute:`);
  console.log(`  node -e "const{ethers}=require('ethers');const d=require('./app/deployments.json');`);
  console.log(`  (async()=>{const p=new ethers.JsonRpcProvider(process.env.CSB_RPC_URL);`);
  console.log(`  const t=new ethers.Contract(d.bridged.${key}.address,['function balanceOf(address) view returns (uint256)'],p);`);
  console.log(`  console.log(await t.balanceOf('${recipient}'))})()"`);
  console.log(`\nIf it stays zero, the relayer is not delivering Fuji -> CSB:`);
  console.log(`  avalanche interchain relayer logs`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
