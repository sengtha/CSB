const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Verify and record a bridged asset that has arrived on CSB from Fuji.
 *
 *   source ops/csb-env.sh
 *   CSB_BRIDGED_TOKEN=0x… npx hardhat run scripts/usdc-ingress.js --network csbRemote
 *
 * Environment:
 *   CSB_BRIDGED_TOKEN   the ERC20TokenRemote deployed on CSB           (required)
 *   CSB_BRIDGED_KEY     key to record it under in deployments.json     (default "usdc")
 *   CSB_EXPECT_SYMBOL   refuse if symbol() differs                     (default none)
 *
 * WHAT THIS IS NOT. It does not deploy anything and it does not bridge anything.
 * The ICTT pair is created with avalanche-cli against Fuji — see docs/usdc-ingress.md.
 * This is the step afterwards: prove the contract on CSB is what it claims to be,
 * then record it so the pool, the oracle and the app can find it.
 *
 * WHY A SEPARATE VERIFICATION STEP EXISTS AT ALL. The addresses printed by
 * `avalanche interchain tokenTransferrer deploy` are easy to transpose — the run
 * prints a home and a remote on two different chains, and docs/fuji-ictt.md records
 * that its ICM table shows Fuji's addresses while describing CSB. Recording the wrong
 * one produces a pool priced against a contract that is not the bridged token, which
 * is the kind of error that survives a long time because everything still runs.
 *
 * THE COMPLIANCE POSITION, stated here because this script is where somebody will
 * first meet it. What arrives is a PLAIN ERC-20: no identity check, no freeze, no
 * confiscate. That is a deliberate, recorded decision (docs/architecture.md §7.1) and
 * not an oversight. Its safety rests on `txAllowList` — an address that cannot
 * transact can hold this token but can do nothing else with it — so the script
 * reports the allow-list posture rather than leaving it implicit.
 */

const TX_ALLOWLIST = "0x0200000000000000000000000000000000000002";
const ALLOWLIST_ABI = ["function readAllowList(address) view returns (uint256)"];
const ROLE = { 0: "none — cannot transact", 1: "enabled", 2: "admin", 3: "manager" };

const TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

// ERC20TokenRemote's own surface. Reading these is what distinguishes a genuine
// bridge remote from an ordinary ERC-20 someone deployed by hand.
const REMOTE_ABI = [
  "function tokenHomeBlockchainID() view returns (bytes32)",
  "function tokenHomeAddress() view returns (address)",
  "function isRegistered() view returns (bool)",
  "function isCollateralized() view returns (bool)",
];

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();

  const addr = process.env.CSB_BRIDGED_TOKEN;
  if (!addr) {
    throw new Error("Set CSB_BRIDGED_TOKEN to the ERC20TokenRemote deployed on CSB. "
      + "See docs/usdc-ingress.md for how to get one.");
  }
  if (!ethers.isAddress(addr)) throw new Error(`Not a valid address: ${addr}`);

  const key = process.env.CSB_BRIDGED_KEY ?? "usdc";
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  console.log(`Chain    ${(await provider.getNetwork()).chainId}`);
  console.log(`Reading  ${addr}\n`);

  if ((await provider.getCode(addr)).length <= 2) {
    throw new Error(`No contract at ${addr} on this chain. If the address came from an `
      + `avalanche-cli run, check you took the CSB one and not the Fuji one — the CLI `
      + `prints both, and its ICM table shows Fuji's addresses (docs/fuji-ictt.md §1).`);
  }

  const token = new ethers.Contract(addr, TOKEN_ABI, provider);
  const [name, symbol, decimals, supply] = await Promise.all([
    token.name().catch(() => null),
    token.symbol().catch(() => null),
    token.decimals().then(Number).catch(() => null),
    token.totalSupply().catch(() => null),
  ]);
  if (symbol === null || decimals === null) {
    throw new Error("That address does not answer symbol()/decimals() — it is not an ERC-20.");
  }

  console.log(`  name      ${name}`);
  console.log(`  symbol    ${symbol}`);
  console.log(`  decimals  ${decimals}`);
  console.log(`  supply    ${ethers.formatUnits(supply ?? 0n, decimals)}`);

  const expect = process.env.CSB_EXPECT_SYMBOL;
  if (expect && symbol !== expect) {
    throw new Error(`Symbol is "${symbol}", expected "${expect}". Refusing to record it.`);
  }

  // --- is it actually a bridge remote? --------------------------------------
  const remote = new ethers.Contract(addr, REMOTE_ABI, provider);
  const [homeChain, homeAddr, registered, collateralized] = await Promise.all([
    remote.tokenHomeBlockchainID().catch(() => null),
    remote.tokenHomeAddress().catch(() => null),
    remote.isRegistered().catch(() => null),
    remote.isCollateralized().catch(() => null),
  ]);

  if (homeChain === null) {
    console.log(`\n  WARNING: this answers ERC-20 calls but not tokenHomeBlockchainID(),`);
    console.log(`  so it is NOT an ERC20TokenRemote. It may be an ordinary token someone`);
    console.log(`  deployed here. Recording it anyway, but nothing will bridge to it.`);
  } else {
    console.log(`\n  home chain    ${homeChain}`);
    console.log(`  home contract ${homeAddr}`);
    console.log(`  registered    ${registered}`);
    console.log(`  collateralized ${collateralized}`);
    if (registered === false) {
      console.log(`\n  NOT REGISTERED with its home. Tokens cannot be bridged until`);
      console.log(`  registerWithHome() has been called and the message delivered:`);
      console.log(`    CSB_TOKEN_REMOTE=${addr} node scripts/register-remote.js`);
      console.log(`  (that runs against the HOME chain — read it before running it here)`);
    }
  }

  // --- the compliance posture, said out loud --------------------------------
  console.log(`\n${"-".repeat(70)}`);
  console.log(`THIS TOKEN IS NOT GATED. No identity check, no freeze, no confiscate —`);
  console.log(`unlike KHRt, which enforces all three on every transfer. That is a`);
  console.log(`recorded decision (docs/architecture.md §7.1), not an oversight.`);
  console.log(`The only control is txAllowList: an address that cannot transact can`);
  console.log(`hold this token but cannot spend, bridge or delegate it.`);
  console.log(`${"-".repeat(70)}`);

  const allow = new ethers.Contract(TX_ALLOWLIST, ALLOWLIST_ABI, provider);
  let role = null;
  try { role = Number(await allow.readAllowList(signer.address)); } catch { /* absent */ }
  console.log(`  your txAllowList role: ${role === null ? "unreadable" : (ROLE[role] ?? role)}`);
  console.log(`  audit who else can move it:`);
  console.log(`    npx hardhat run scripts/audit-allowlist.js --network csbRemote`);

  // --- record ---------------------------------------------------------------
  const existing = d.bridged?.[key];
  if (existing && existing.address?.toLowerCase() !== addr.toLowerCase()) {
    console.log(`\n  NOTE: replacing a previously recorded "${key}" (${existing.address}).`);
    console.log(`  The old one still exists on chain — check it is not holding value.`);
  }

  d.bridged = {
    ...(d.bridged ?? {}),
    [key]: {
      address: addr,
      symbol,
      decimals,
      name,
      homeBlockchainID: homeChain,
      homeAddress: homeAddr,
      note: "Bridged in over ICTT. UNGATED by design — no identity hook, no freeze, "
        + "no confiscate. See docs/architecture.md §7.1.",
    },
  };
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log(`\nRecorded as bridged.${key} in ${path.basename(file)}.`);
  console.log(`\nNext: build a market against it —`);
  console.log(`  npx hardhat run scripts/usdc-market.js --network csbRemote`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
