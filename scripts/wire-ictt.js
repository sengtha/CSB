const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { explain } = require("./lib/csb-precompiles");

/**
 * Wire real egress: CSB -> Fuji C-Chain over Avalanche ICTT.
 *
 * This is step 4-5 of docs/fuji-ictt.md. It does NOT deploy the ICTT pair — that
 * is avalanche-cli's job and it needs Fuji AVAX for the C-Chain side. Deploy the
 * pair first, then run this to connect it to CSB's egress policy:
 *
 *   source ops/csb-env.sh
 *   CSB_TOKEN_HOME=0x…      \   # ERC20TokenHome on CSB (holds the collateral)
 *   CSB_TOKEN_REMOTE=0x…    \   # ERC20TokenRemote on the Fuji C-Chain
 *   CSB_DEST_BLOCKCHAIN_ID=0x… \# Fuji C-Chain blockchainID, 32-byte hex
 *     npx hardhat run scripts/wire-ictt.js --network csbRemote
 *
 * Optional:
 *   CSB_DEST_GAS       gas limit for delivery on the destination (default 250000)
 *   CSB_EGRESS_TIER    minimum KYC tier allowed to bridge (default 2)
 *   CSB_EGRESS_CAP     daily cap in KHRt units, 2dp (default 1_000_000_00)
 *   CSB_DEST_LABEL     the gateway's logical destination name (default avalanche-c-chain)
 *
 * What it changes, all of it council-signed:
 *   1. deploys ICTTBridgeAdapter(KHRt, TokenHome, council)
 *   2. adapter.setGateway(EgressGateway) and setRoute(dest -> remote)
 *   3. marks the adapter AND the TokenHome as KHRt system contracts — neither is
 *      a person, so neither can hold a KYC attestation, and without this the
 *      first transfer into them reverts on compliance
 *   4. points the gateway's KHRt policy at the real adapter
 *
 * IT DOES NOT run a relayer. Without one, sends lock collateral on CSB and never
 * arrive on Fuji — the tokens are not lost, but they do not appear either, and
 * that looks exactly like a bug. Start the relayer before testing.
 */
async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [signer] = await ethers.getSigners();

  const need = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} is required — see docs/fuji-ictt.md`);
    return v;
  };
  const tokenHome = need("CSB_TOKEN_HOME");
  const tokenRemote = need("CSB_TOKEN_REMOTE");
  const destId = need("CSB_DEST_BLOCKCHAIN_ID");
  const destGas = BigInt(process.env.CSB_DEST_GAS ?? 250000);
  const minTier = Number(process.env.CSB_EGRESS_TIER ?? 2);
  const dailyCap = BigInt(process.env.CSB_EGRESS_CAP ?? 1_000_000_00);
  const destLabel = process.env.CSB_DEST_LABEL ?? "avalanche-c-chain";
  const destKey = ethers.id(destLabel);

  for (const [name, v] of [["CSB_TOKEN_HOME", tokenHome], ["CSB_TOKEN_REMOTE", tokenRemote]]) {
    if (!ethers.isAddress(v)) throw new Error(`${name} is not an address: ${v}`);
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(destId)) {
    throw new Error(`CSB_DEST_BLOCKCHAIN_ID must be 32-byte hex (0x + 64 chars), got: ${destId}`);
  }
  // A TokenHome with no code is the most likely mistake here — an address typed
  // from the wrong chain's output. Every later step would "succeed" and the
  // first real bridge would revert with nothing to explain it.
  if ((await ethers.provider.getCode(tokenHome)) === "0x") {
    throw new Error(`No contract at CSB_TOKEN_HOME ${tokenHome} on THIS chain. The TokenHome lives on CSB, the TokenRemote on Fuji — check you have not swapped them.`);
  }

  const khr = await ethers.getContractAt("KHRStablecoin", d.contracts.KHRStablecoin);
  const gateway = await ethers.getContractAt("EgressGateway", d.contracts.EgressGateway);

  console.log(`Signer:       ${signer.address}`);
  console.log(`KHRt:         ${khr.target}`);
  console.log(`Gateway:      ${gateway.target}`);
  console.log(`TokenHome:    ${tokenHome}   (on CSB)`);
  console.log(`TokenRemote:  ${tokenRemote}   (on Fuji C-Chain)`);
  console.log(`Destination:  "${destLabel}" -> ${destId}\n`);

  // 1 + 2 — adapter
  let adapter;
  if (d.contracts.ICTTBridgeAdapter) {
    adapter = await ethers.getContractAt("ICTTBridgeAdapter", d.contracts.ICTTBridgeAdapter);
    console.log(`Using existing ICTTBridgeAdapter ${adapter.target}`);
  } else {
    console.log("Deploying ICTTBridgeAdapter…");
    adapter = await ethers.deployContract("ICTTBridgeAdapter", [khr.target, tokenHome, signer.address]);
    await adapter.waitForDeployment();
    d.contracts.ICTTBridgeAdapter = adapter.target;
    fs.writeFileSync(file, JSON.stringify(d, null, 2));
    console.log(`  ICTTBridgeAdapter ${adapter.target}`);
  }

  if ((await adapter.gateway()).toLowerCase() !== gateway.target.toLowerCase()) {
    await (await adapter.setGateway(gateway.target)).wait();
    console.log("  gateway set");
  } else console.log("  gateway already set");

  await (await adapter.setRoute(destKey, destId, tokenRemote, destGas)).wait();
  console.log(`  route set: ${destLabel} -> ${tokenRemote} (gas ${destGas})`);

  // 3 — both are contracts, so neither can hold KYC
  for (const [label, addr] of [["ICTTBridgeAdapter", adapter.target], ["ERC20TokenHome", tokenHome]]) {
    if (await khr.isSystemContract(addr)) {
      console.log(`  ${label} already vetted as a system contract`);
    } else {
      await (await khr.setSystemContract(addr, true)).wait();
      console.log(`  ${label} vetted as a system contract (may custody KHRt without KYC)`);
    }
  }

  // 4 — policy now points at the real transport
  await (await gateway.setTokenPolicy(khr.target, true, minTier, dailyCap, adapter.target)).wait();
  console.log(`\nGateway policy: KHRt permitted, min tier ${minTier}, daily cap ${Number(dailyCap) / 100} KHRt,`);
  console.log(`adapter ${adapter.target}`);

  // Record the destination so the wallet page offers it.
  d.pilot = d.pilot ?? {};
  d.pilot.destinationChain = { label: "Avalanche C-Chain (Fuji)", id: destKey };

  // Record the ICTT pair itself. Without this nothing in the browser can find
  // the bridge: the return path (Fuji -> CSB) has to call send() on the REMOTE
  // contract, and the address only ever existed in the deploy output and in
  // whichever terminal was open at the time.
  d.ictt = {
    tokenHome,                 // ERC20TokenHome, on CSB — holds the collateral
    tokenRemote,               // ERC20TokenRemote, on the destination chain
    destBlockchainId: destId,  // destination chain, 32-byte hex
    destLabel,
    destGas: Number(destGas),
    destKey,                   // the gateway's logical destination id
  };
  fs.writeFileSync(file, JSON.stringify(d, null, 2));

  const policy = await gateway.policies(khr.target);
  console.log("\nVerified on chain:");
  console.log(`  allowed=${policy[0]} minTier=${policy[1]} dailyCap=${policy[2]} adapter=${policy[3]}`);
  console.log(`  route  =${JSON.stringify(await adapter.routes(destKey), (k, v) => (typeof v === "bigint" ? v.toString() : v))}`);

  console.log("\nBefore testing, make sure an ICM relayer is running. Without one the send");
  console.log("locks collateral on CSB and never delivers on Fuji — which looks like a bug");
  console.log("but is simply an undelivered message.");
}

main().catch((e) => {
  console.error("\nFailed:", explain(e));
  process.exitCode = 1;
});
