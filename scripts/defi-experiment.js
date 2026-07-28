const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deploy UNMODIFIED Uniswap V2 to the live CSB chain and measure what the
 * compliance perimeter actually contains.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/defi-experiment.js --network csbRemote
 *
 * This is the live counterpart to test/defi-unmodified.test.js. The local test
 * runs against the hardhat network, where the allow-list precompiles are mocked;
 * here the real `txAllowList` and `contractDeployerAllowList` precompiles are in
 * the loop, which is the difference between "we think" and "we measured".
 *
 * "Unmodified" is literal: the bytecode comes from the published npm artifacts
 * with no recompilation. The published core's pair init-code hash equals the
 * value hardcoded in the published router, so these are the genuine upstream
 * pair rather than a local rebuild.
 *
 * WHAT IT COSTS. Deploying the factory is a large transaction — at the 1-riel
 * fee policy (minBaseFee 47,619 gwei) expect on the order of 150-250 tRIEL for
 * the whole run. The script prints the real figure per step, which is itself
 * data the paper needs: nobody has published what an ordinary DeFi deployment
 * costs on a chain that prices gas as fiscal policy.
 *
 * WHAT IT LEAVES BEHIND. A Uniswap factory, a pool, and a test ERC-20, all
 * permanent. The pool is marked a KHRt system contract, which is a real
 * privilege — revoke it afterwards if this chain is being shown to anyone:
 *   khr.setSystemContract(<pair>, false)
 */
const FACTORY = require("@uniswap/v2-core/build/UniswapV2Factory.json");
const PAIR = require("@uniswap/v2-core/build/UniswapV2Pair.json");
const ERC20 = require("@uniswap/v2-core/build/ERC20.json");

const TX_ALLOWLIST = "0x0200000000000000000000000000000000000002";
const ALLOWLIST_ABI = ["function readAllowList(address) view returns (uint256)"];
const ROLE_NAME = { 0: "none (cannot transact)", 1: "enabled", 2: "admin", 3: "manager" };

const hex = (b) => (b.startsWith("0x") ? b : "0x" + b);
const riel = (n) => (Number(n) / 100).toFixed(2);

const results = [];
function record(step, outcome, detail) {
  results.push({ step, outcome, detail });
  const mark = outcome === "PASS" ? "✓" : outcome === "EXPECTED-REVERT" ? "✓" : "✗";
  console.log(`  ${mark} ${step}${detail ? `\n      ${detail}` : ""}`);
}

async function cost(tx, ethers) {
  const rc = await tx.wait();
  const spent = rc.gasUsed * rc.gasPrice;
  return { rc, gas: rc.gasUsed, triel: ethers.formatEther(spent) };
}

async function main() {
  const { ethers } = hre;
  const [signer] = await ethers.getSigners();
  const provider = ethers.provider;
  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = d.contracts ?? {};

  console.log(`Chain     ${(await provider.getNetwork()).chainId}`);
  console.log(`Signer    ${signer.address}`);
  console.log(`Balance   ${ethers.formatEther(await provider.getBalance(signer.address))} tRIEL`);
  const block = await provider.getBlock("latest");
  console.log(`Base fee  ${ethers.formatUnits(block?.baseFeePerGas ?? 0n, "gwei")} gwei\n`);

  const khr = new ethers.Contract(c.KHRStablecoin, [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
    "function issue(address,uint256)",
    "function setSystemContract(address,bool)",
    "function identity() view returns (address)",
    "function enforcement() view returns (address)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
    "function ISSUER_ROLE() view returns (bytes32)",
  ], signer);

  const identity = new ethers.Contract(await khr.identity(), [
    "function register(address,bytes32,uint8)",
    "function isActive(address) view returns (bool)",
    "function tierOf(address) view returns (uint8)",
    "function hasRole(bytes32,address) view returns (bool)",
    "function ISSUER_ROLE() view returns (bytes32)",
  ], signer);

  // --- capability check ----------------------------------------------------
  // Fail here with a sentence rather than three steps in with a selector.
  const [isAdmin, isIssuer, isIdIssuer] = await Promise.all([
    khr.hasRole(await khr.DEFAULT_ADMIN_ROLE(), signer.address),
    khr.hasRole(await khr.ISSUER_ROLE(), signer.address),
    identity.hasRole(await identity.ISSUER_ROLE(), signer.address),
  ]);
  console.log(`Roles     KHRt admin=${isAdmin} KHRt issuer=${isIssuer} identity issuer=${isIdIssuer}`);
  if (!isAdmin) throw new Error("Signer lacks KHRt DEFAULT_ADMIN_ROLE — cannot mark the pool a system contract.");
  if (!isIssuer) throw new Error("Signer lacks KHRt ISSUER_ROLE — cannot mint the KHRt this experiment needs.");

  if (!(await identity.isActive(signer.address))) {
    if (!isIdIssuer) throw new Error("Signer is not KYC-active and cannot self-register. Approve it in Admin first.");
    console.log("Signer is not KYC-active — registering at tier 2…");
    await (await identity.register(signer.address, ethers.id("defi-experiment-lp"), 2)).wait();
  }
  console.log(`Signer KYC tier ${await identity.tierOf(signer.address)}\n`);

  // A fresh address that has never touched this chain: no KYC attestation, and
  // not on the transaction allow list. This is the counterparty that should be
  // unable to hold anything — and the point of the experiment is what it CAN
  // hold. Generated randomly so it cannot have prior state.
  const outsider = ethers.Wallet.createRandom().address;
  const allowList = new ethers.Contract(TX_ALLOWLIST, ALLOWLIST_ABI, provider);
  let outsiderRole = null;
  try { outsiderRole = Number(await allowList.readAllowList(outsider)); } catch { /* precompile absent */ }
  console.log(`Outsider  ${outsider}`);
  console.log(`  txAllowList role: ${outsiderRole === null ? "unreadable" : ROLE_NAME[outsiderRole]}`);
  console.log(`  KYC active:       ${await identity.isActive(outsider)}\n`);

  let totalTriel = 0;
  const spend = (t) => { totalTriel += Number(t); };

  // === 1. deploy the published artifacts, unchanged ========================
  console.log("1. Deploying unmodified Uniswap V2");
  const factoryF = new ethers.ContractFactory(FACTORY.abi, hex(FACTORY.bytecode), signer);
  const factory = await factoryF.deploy(signer.address);
  const fRc = await factory.deploymentTransaction().wait();
  spend(ethers.formatEther(fRc.gasUsed * fRc.gasPrice));
  record("UniswapV2Factory deploys with no source change", "PASS",
    `${await factory.getAddress()}  gas ${fRc.gasUsed}  ${ethers.formatEther(fRc.gasUsed * fRc.gasPrice)} tRIEL`);

  const initHash = ethers.keccak256(hex(PAIR.bytecode));
  record("published pair init-code hash matches the published router's constant",
    initHash === "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f" ? "PASS" : "FAIL",
    initHash);

  const plainF = new ethers.ContractFactory(ERC20.abi, hex(ERC20.bytecode), signer);
  const plain = await plainF.deploy(ethers.parseEther("1000000"));
  const pRc = await plain.deploymentTransaction().wait();
  spend(ethers.formatEther(pRc.gasUsed * pRc.gasPrice));
  record("plain compliance-free ERC-20 deploys (the counterparty asset)", "PASS",
    `${await plain.getAddress()}  ${ethers.formatEther(pRc.gasUsed * pRc.gasPrice)} tRIEL`);

  // === 2. pool creation vs. first use ======================================
  console.log("\n2. Pool creation and the whitelist window");
  const cp = await cost(await factory.createPair(c.KHRStablecoin, await plain.getAddress()), ethers);
  spend(cp.triel);
  const pairAddr = await factory.getPair(c.KHRStablecoin, await plain.getAddress());
  record("createPair succeeds — it moves no tokens, so nothing checks compliance", "PASS",
    `${pairAddr}  ${cp.triel} tRIEL`);

  await (await khr.issue(signer.address, 500_000_00)).wait();

  // The pool exists and cannot hold the regulated asset.
  try {
    await khr.transfer.staticCall(pairAddr, 1000_00);
    record("KHRt transfer into the un-whitelisted pool", "FAIL", "it SUCCEEDED — the perimeter is not holding");
  } catch (e) {
    record("KHRt transfer into the un-whitelisted pool reverts", "EXPECTED-REVERT",
      String(e.shortMessage ?? e.message).slice(0, 120));
  }

  const sc = await cost(await khr.setSystemContract(pairAddr, true), ethers);
  spend(sc.triel);
  record("council marks the pool a system contract (only possible AFTER createPair)", "PASS",
    `${sc.triel} tRIEL — CREATE2 fixes the address at creation, so this cannot be pre-authorised`);

  // === 3. liquidity and a compliant swap ==================================
  console.log("\n3. Liquidity and swaps");
  const pair = new ethers.Contract(pairAddr, PAIR.abi, signer);
  const t1 = await cost(await khr.transfer(pairAddr, 200_000_00), ethers); spend(t1.triel);
  const t2 = await cost(await plain.transfer(pairAddr, ethers.parseEther("200000")), ethers); spend(t2.triel);
  const mint = await cost(await pair.mint(signer.address), ethers); spend(mint.triel);
  const lp = await pair.balanceOf(signer.address);
  record("liquidity provided once the pool is whitelisted", "PASS",
    `LP balance ${ethers.formatEther(lp)}  mint cost ${mint.triel} tRIEL`);

  const khrIsToken0 = (await pair.token0()).toLowerCase() === c.KHRStablecoin.toLowerCase();
  const t3 = await cost(await plain.transfer(pairAddr, ethers.parseEther("1000")), ethers); spend(t3.triel);
  const before = await khr.balanceOf(signer.address);
  const out = 900_00n;
  const sw = await cost(await pair.swap(khrIsToken0 ? out : 0n, khrIsToken0 ? 0n : out, signer.address, "0x"), ethers);
  spend(sw.triel);
  record("swap out to a KYC-verified address", "PASS",
    `+${riel((await khr.balanceOf(signer.address)) - before)} KHRt  ${sw.triel} tRIEL`);

  // === 4. the perimeter at the pool edge ==================================
  console.log("\n4. Does the perimeter hold?");
  try {
    await pair.swap.staticCall(khrIsToken0 ? 100_00n : 0n, khrIsToken0 ? 0n : 100_00n, outsider, "0x");
    record("swap out to a NON-KYC'd address", "FAIL", "it SUCCEEDED — regulated value left the perimeter");
  } catch (e) {
    record("swap out to a NON-KYC'd address reverts — the asset cannot leave", "EXPECTED-REVERT",
      String(e.shortMessage ?? e.message).slice(0, 120));
  }

  try {
    await khr.transfer.staticCall(outsider, 1);
    record("direct KHRt transfer to the outsider", "FAIL", "it SUCCEEDED — the perimeter is not holding");
  } catch (e) {
    record("direct KHRt transfer to the outsider reverts", "EXPECTED-REVERT",
      String(e.shortMessage ?? e.message).slice(0, 120));
  }

  // === 5. the leak ========================================================
  console.log("\n5. The claim on the asset");
  const lpMove = await cost(await pair.transfer(outsider, lp / 2n), ethers);
  spend(lpMove.triel);
  const outsiderLp = await pair.balanceOf(outsider);
  record(
    outsiderLp > 0n
      ? "LP TOKENS TRANSFER TO THE OUTSIDER — a claim on pooled KHRt, held by an address with no attestation"
      : "LP transfer to the outsider produced no balance",
    outsiderLp > 0n ? "PASS" : "FAIL",
    `outsider LP balance ${ethers.formatEther(outsiderLp)}  (KHRt balance ${riel(await khr.balanceOf(outsider))}, `
    + `txAllowList ${outsiderRole === null ? "unreadable" : ROLE_NAME[outsiderRole]})`);

  // Record what was deployed so app/public/defi.html can find the pool. Written
  // under `defi` rather than `contracts`, because these are an experiment's
  // artifacts and should not be mistaken for part of the CSB contract suite.
  d.defi = {
    factory: await factory.getAddress(),
    pair: pairAddr,
    testToken: await plain.getAddress(),
    khr: c.KHRStablecoin,
    note: "Unmodified Uniswap V2 (published artifacts). See docs/defi.md.",
  };
  fs.writeFileSync(file, JSON.stringify(d, null, 2));
  console.log(`\nRecorded the pool in ${path.basename(file)} — it will appear on defi.html.`);

  // === summary ============================================================
  console.log(`\n${"=".repeat(72)}`);
  console.log("SUMMARY");
  console.log("=".repeat(72));
  for (const r of results) console.log(`  ${r.outcome.padEnd(16)} ${r.step}`);
  console.log(`\n  Total gas cost of the experiment: ${totalTriel.toFixed(2)} tRIEL`);
  console.log(`  Factory   ${await factory.getAddress()}`);
  console.log(`  Pool      ${pairAddr}`);
  console.log(`  Test ERC20 ${await plain.getAddress()}`);
  console.log(`  Outsider  ${outsider}`);
  console.log(`\n  The pool is now a KHRt system contract. To undo that:`);
  console.log(`    khr.setSystemContract("${pairAddr}", false)`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
