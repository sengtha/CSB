const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * DEMO: route a flat public-good levy to a charity on every KHRt transfer, to
 * illustrate "a small donation on every payment" in terms people recognise.
 *
 * ILLUSTRATIVE EXAMPLE ONLY. The default label references a children's-hospital
 * charity (Kantha Bopha) purely as a relatable placeholder. This script does
 * NOT create or control that organisation's real wallet, implies NO affiliation
 * or endorsement, and moves valueless TEST tokens only. Pass CSB_CHARITY_ADDR to
 * use a specific, already-KYC'd address instead of a generated demo account.
 *
 * Effect: KHRt.transferLevy = 1.00 KHRt (= 1 riel) to the recipient, so each
 * transfer sends 1 riel to the fund and the remainder to the payee. Disable with
 * CSB_LEVY_UNITS=0 (or setTransferLevy(0, …) from the admin console).
 *
 * Requires the deployer to hold the Identity Authority + council roles (pilot).
 *   CSB_RPC_URL=$RPC CSB_CHAIN_ID=8555 CSB_DEPLOYER_KEY=0x... \
 *     npx hardhat run scripts/enable-charity-levy.js --network csbRemote
 */
async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  const deployments = JSON.parse(fs.readFileSync(file, "utf8"));
  const identity = await ethers.getContractAt("IdentityRegistry", deployments.contracts.IdentityRegistry);
  const khr = await ethers.getContractAt("KHRStablecoin", deployments.contracts.KHRStablecoin);

  const label = process.env.CSB_CHARITY_LABEL
    ?? "Kantha Bopha Foundation (illustrative example — not affiliated, test tokens only)";
  const levyUnits = BigInt(process.env.CSB_LEVY_UNITS ?? "100"); // 1.00 KHRt

  let charity = process.env.CSB_CHARITY_ADDR;
  if (charity) {
    if (!(await identity.isActive(charity))) {
      await (await identity.register(charity, ethers.id("identity-charity"), 4)).wait();
      console.log(`Registered charity ${charity} as full KYC (tier 4, institutional).`);
    }
  } else {
    const w = ethers.Wallet.createRandom();
    charity = w.address;
    await (await identity.register(charity, ethers.id("identity-charity-demo"), 4)).wait();
    deployments.pilot = deployments.pilot ?? {};
    deployments.pilot.charity = {
      address: charity,
      key: w.privateKey,
      label,
      note: "DEMO charity levy recipient — valueless test tokens only; not a real organisation's wallet.",
    };
    fs.writeFileSync(file, JSON.stringify(deployments, null, 2));
    console.log(`Created demo charity KYC account: ${charity}\n(key saved to ${file} — DEV ONLY)`);
  }

  await (await khr.setTransferLevy(levyUnits, charity)).wait();

  console.log(`\nPublic-good levy ${levyUnits === 0n ? "DISABLED" : "ENABLED"}.`);
  if (levyUnits > 0n) {
    console.log(`  ${Number(levyUnits) / 100} KHRt (= ${Number(levyUnits) / 100} riel) per KHRt transfer → ${label}`);
    console.log(`  Recipient: ${charity}`);
    console.log(`  Collected so far: ${Number(await khr.totalLevied()) / 100} KHRt`);
  }
  console.log(`\nIllustrative demo — valueless test tokens, no affiliation with any real organisation.`);
  console.log(`Turn off any time: CSB_LEVY_UNITS=0 re-run, or setTransferLevy(0, <addr>) in the admin console.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
