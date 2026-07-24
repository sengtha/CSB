const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Onboard a developer address to the permissioned CSB chain so they can deploy
 * contracts and transact from MetaMask / Hardhat / Remix.
 *
 * CSB gates activity with two Subnet-EVM allowlist precompiles, so a new address
 * can do nothing until an admin enables it:
 *   - txAllowList              — permission to submit ANY transaction
 *   - contractDeployerAllowList — permission to DEPLOY contracts
 * The address also needs native tRIEL for gas. This script does all three,
 * signed by the deployer (the admin of both precompiles).
 *
 * Note: this grants developer/technical access, NOT KYC. Holding or transferring
 * KHRt additionally requires an IdentityRegistry attestation (admin console).
 *
 * Usage (on the VM, with the deployer key):
 *   CSB_RPC_URL=$RPC CSB_CHAIN_ID=8555 CSB_DEPLOYER_KEY=0x... \
 *   CSB_DEV_ADDR=0xDev1,0xDev2 \
 *     npx hardhat run scripts/allow-dev.js --network csbRemote
 *
 * Optional env:
 *   CSB_DEV_GAS      tRIEL to fund each dev address with (default "10")
 *   CSB_DEV_DEPLOYER set "0" to grant tx access only (no contract-deploy rights)
 */
const TX_ALLOWLIST = "0x0200000000000000000000000000000000000002";
const DEPLOYER_ALLOWLIST = "0x0200000000000000000000000000000000000000";
const ALLOWLIST_ABI = [
  "function setEnabled(address addr)",
  "function setNone(address addr)",
  "function readAllowList(address addr) view returns (uint256)",
];
const ROLE = { 0: "none", 1: "enabled", 2: "admin", 3: "manager" };

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [deployer] = await ethers.getSigners();

  const addrs = (process.env.CSB_DEV_ADDR ?? "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (addrs.length === 0) throw new Error("Set CSB_DEV_ADDR=0xdev1,0xdev2 (comma-separated).");
  for (const a of addrs) if (!ethers.isAddress(a)) throw new Error(`Not an address: ${a}`);

  const grantDeploy = process.env.CSB_DEV_DEPLOYER !== "0";
  const gas = ethers.parseEther(process.env.CSB_DEV_GAS ?? "10");

  // Explicit high fee + explicit nonce, so txs can't get stuck under-priced or
  // queued behind an earlier stuck tx (same approach as scripts/fund-native.js).
  const block = await provider.getBlock("latest");
  const baseFee = block?.baseFeePerGas ?? 0n;
  const fees = {
    maxFeePerGas: baseFee * 20n + ethers.parseUnits("3000", "gwei"),
    maxPriorityFeePerGas: ethers.parseUnits("500", "gwei"),
  };
  let nonce = await provider.getTransactionCount(deployer.address, "latest");

  const txAllow = new ethers.Contract(TX_ALLOWLIST, ALLOWLIST_ABI, deployer);
  const deployAllow = new ethers.Contract(DEPLOYER_ALLOWLIST, ALLOWLIST_ABI, deployer);

  console.log(`Deployer (admin): ${deployer.address}`);
  console.log(`Granting: tx-access${grantDeploy ? " + contract-deploy" : ""}, ${ethers.formatEther(gas)} tRIEL gas\n`);

  const submitted = [];
  for (const a of addrs) {
    console.log(`  ${a}`);
    // 1) transaction allow list
    if ((await txAllow.readAllowList(a)) === 0n) {
      const tx = await txAllow.setEnabled(a, { ...fees, nonce: nonce++ });
      submitted.push({ label: `${a} txAllowList`, hash: tx.hash });
      console.log(`    tx-allowlist enable … ${tx.hash}`);
    } else console.log(`    tx-allowlist: already ${ROLE[Number(await txAllow.readAllowList(a))]}`);

    // 2) contract deployer allow list
    if (grantDeploy) {
      if ((await deployAllow.readAllowList(a)) === 0n) {
        const tx = await deployAllow.setEnabled(a, { ...fees, nonce: nonce++ });
        submitted.push({ label: `${a} deployerAllowList`, hash: tx.hash });
        console.log(`    deployer-allowlist enable … ${tx.hash}`);
      } else console.log(`    deployer-allowlist: already ${ROLE[Number(await deployAllow.readAllowList(a))]}`);
    }

    // 3) native gas
    const bal = await provider.getBalance(a);
    if (bal < gas) {
      const tx = await deployer.sendTransaction({ to: a, value: gas - bal, ...fees, nonce: nonce++ });
      submitted.push({ label: `${a} gas`, hash: tx.hash });
      console.log(`    fund ${ethers.formatEther(gas - bal)} tRIEL … ${tx.hash}`);
    } else console.log(`    gas: already ${ethers.formatEther(bal)} tRIEL`);
  }

  if (submitted.length === 0) {
    console.log("\nNothing to do — all dev addresses already enabled and funded.");
    return;
  }

  console.log("\nWaiting for confirmations…");
  for (const s of submitted) {
    const r = await waitWithTimeout(provider, s.hash, 120_000);
    console.log(r ? `  ✓ ${s.label} (block ${r.blockNumber})` : `  ⏳ ${s.label} not mined in 120s — ${s.hash}`);
  }
  console.log("\nDone. The dev can now add the CSB network to MetaMask and deploy (see README / docs/dev-access.md).");
}

async function waitWithTimeout(provider, hash, ms) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const r = await provider.getTransactionReceipt(hash);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 2000));
  }
  return null;
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
