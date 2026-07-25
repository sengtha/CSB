const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Optionally seeds a freshly deployed suite with pilot/test accounts for the
 * wallet/explorer/admin UIs. Assumes the deployer holds all roles (pilot
 * mode). Reads addresses from app/deployments.json (written by
 * scripts/deploy.js) and appends the generated account keys to it.
 *
 * On the real CSB L1, accounts must also be enabled in the txAllowList
 * precompile before they can transact — this script now does that for the
 * funded pilot accounts (Vanna is left disabled on purpose).
 *
 * Pilot cast:
 *   Sokha  — tier 2 citizen (full KYC), funded
 *   Dara   — tier 1 citizen (capped),  funded
 *   Vanna  — not KYC'd (every action involving Vanna fails, on purpose)
 */
async function main() {
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  const deployments = JSON.parse(fs.readFileSync(file, "utf8"));
  const { ethers } = hre;
  const [deployer] = await ethers.getSigners();

  const identity = await ethers.getContractAt("IdentityRegistry", deployments.contracts.IdentityRegistry);
  const khr = await ethers.getContractAt("KHRStablecoin", deployments.contracts.KHRStablecoin);
  const gateway = await ethers.getContractAt("EgressGateway", deployments.contracts.EgressGateway);

  const sokha = ethers.Wallet.createRandom().connect(ethers.provider);
  const dara = ethers.Wallet.createRandom().connect(ethers.provider);
  const vanna = ethers.Wallet.createRandom().connect(ethers.provider);

  // Fund native gas for every seeded account. Even where the CSB fee floor is
  // set to zero, the node still reserves maxFeePerGas * gasLimit from the
  // sender's NATIVE balance up front (ethers populates a non-zero maxFeePerGas
  // from the node's fee suggestion), so an account holding KHRt but zero tRIEL
  // cannot send a single transfer. Always give them gas money — a tiny amount
  // is harmless on a truly-free-gas chain and essential otherwise. (To top up
  // already-seeded accounts on the live chain, use scripts/fund-native.js.)
  // 1000 tRIEL = 1000 riel, a fraction of a US cent, but enough for a few
  // hundred payments under the "~1 tRIEL per transfer" fee policy. (10 tRIEL,
  // the old amount, buys roughly two KHRt transfers once gas is priced.)
  const gasMoney = ethers.parseEther(process.env.CSB_SEED_GAS ?? "1000");
  for (const w of [sokha, dara, vanna]) {
    await (await deployer.sendTransaction({ to: w.address, value: gasMoney })).wait();
  }

  // Enable the funded pilot accounts in the txAllowList precompile so they can
  // submit transactions at all. KYC gates KHRt transfers; txAllowList gates
  // sending ANY transaction on the permissioned chain — both are required.
  // Vanna is intentionally left disabled to demonstrate the chain-level gate.
  // No-op on a local Hardhat node where the precompile isn't deployed.
  const TX_ALLOWLIST = "0x0200000000000000000000000000000000000002";
  const allowlist = new ethers.Contract(
    TX_ALLOWLIST,
    ["function setEnabled(address addr)"],
    deployer,
  );
  try {
    await (await allowlist.setEnabled(sokha.address)).wait();
    await (await allowlist.setEnabled(dara.address)).wait();
    console.log("txAllowList: enabled Sokha and Dara (Vanna left disabled).");
  } catch (e) {
    console.log(`txAllowList precompile not present here — skipping (${e.shortMessage ?? e.message}).`);
  }

  // Register only if the registry hasn't seen them. Re-registering reverts with
  // AlreadyRegistered, which estimateGas reports as a bare "execution reverted"
  // — so a re-run after a partly-failed deploy would look like a new failure
  // rather than work already done.
  // The identity commitment is salted with the address: each seeded run mints
  // NEW wallets, and reusing a fixed commitment would try to attach a second
  // address to an identity whose quota is one — QuotaExceeded, surfacing as a
  // bare "execution reverted" on the re-run.
  await registerIfNeeded(identity, sokha.address, `identity-sokha-${sokha.address}`, 2);
  await registerIfNeeded(identity, dara.address, `identity-dara-${dara.address}`, 1);

  await (await khr.issue(sokha.address, 5_000_000_00)).wait(); // 5,000,000.00 KHRt
  await (await khr.issue(dara.address, 1_000_000_00)).wait();
  await (await khr.setTierTransferCap(1, 400_000_00)).wait(); // tier-1 cap: 400,000 KHRt/transfer

  // Permit KHRt egress to the configured destination through the mock adapter:
  // tier 2 minimum, 1,000,000 KHRt daily cap.
  const destChain = ethers.id("avalanche-c-chain");
  await (
    await gateway.setTokenPolicy(khr.target, true, 2, 1_000_000_00, deployments.contracts.MockBridgeAdapter)
  ).wait();

  deployments.pilot = {
    destinationChain: { label: "Avalanche C-Chain", id: destChain },
    accounts: {
      sokha: { address: sokha.address, key: sokha.privateKey, tier: 2, note: "full KYC, funded" },
      dara: { address: dara.address, key: dara.privateKey, tier: 1, note: "capped tier, funded" },
      vanna: { address: vanna.address, key: vanna.privateKey, tier: 0, note: "NOT KYC'd — rejection cases" },
    },
    deployerKey: null,
  };
  fs.writeFileSync(file, JSON.stringify(deployments, null, 2));

  console.log("Pilot accounts seeded:");
  console.log(`  Sokha (tier 2): ${sokha.address}`);
  console.log(`  Dara  (tier 1): ${dara.address}`);
  console.log(`  Vanna (no KYC): ${vanna.address}`);
  console.log(`\nKeys written to ${file} — PILOT/DEV ONLY, never reuse these keys.`);
}

/**
 * Register an address only if it is not already known to the registry, so the
 * script can be re-run safely after a partial failure.
 */
async function registerIfNeeded(identity, address, idLabel, tier) {
  const { ethers } = require("hardhat");
  const a = await identity.attestationOf(address);
  if (a.identity !== ethers.ZeroHash) {
    console.log(`  ${address} already registered (tier ${a.tier}) — skipping`);
    return;
  }
  await (await identity.register(address, ethers.id(idLabel), tier)).wait();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
