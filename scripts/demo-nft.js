const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const { enableTransactor, explain } = require("./lib/csb-precompiles");

/**
 * Seed the collectible gallery so the assets page has something to show before
 * anyone connects a wallet, and prove the KYC gate in the same run.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/demo-nft.js --network csbRemote
 *
 * ILLUSTRATIVE. The collectible represents nothing and is worth nothing.
 */
async function main() {
  const { ethers } = hre;
  const file = process.env.CSB_DEPLOYMENTS_FILE ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const [deployer] = await ethers.getSigners();

  const identity = await ethers.getContractAt("IdentityRegistry", d.contracts.IdentityRegistry);

  let nft;
  if (d.contracts.CSBCollectible) {
    nft = await ethers.getContractAt("CSBCollectible", d.contracts.CSBCollectible);
    console.log(`Using existing CSBCollectible ${nft.target}`);
  } else {
    console.log("Deploying CSBCollectible…");
    nft = await ethers.deployContract("CSBCollectible", [
      d.contracts.IdentityRegistry, d.contracts.EnforcementRegistry, deployer.address,
    ]);
    await nft.waitForDeployment();
    d.contracts.CSBCollectible = nft.target;
    fs.writeFileSync(file, JSON.stringify(d, null, 2));
    console.log(`  CSBCollectible ${nft.target}`);
  }

  // Mint to whichever pilot accounts already exist, so the gallery reflects the
  // cast the rest of the demos use.
  const holders = [];
  for (const [name, a] of Object.entries(d.pilot?.accounts ?? {})) {
    if (!a?.address) continue;
    if (!(await identity.isActive(a.address))) {
      console.log(`  ${name} has no active KYC — skipping (this is the gate working)`);
      continue;
    }
    holders.push({ name, ...a });
  }
  if (holders.length === 0) {
    console.log("\nNo KYC-active pilot accounts found. Run scripts/seed-accounts.js first.");
    return;
  }

  console.log("\nMinting…");
  for (const h of holders) {
    const [ok, why] = await nft.canMint(h.address);
    if (!ok) { console.log(`  ${h.name}: cannot mint — ${why}`); continue; }
    await (await nft.mintTo(h.address)).wait();
    console.log(`  ${h.name} ${h.address} → token #${await nft.totalMinted()}`);
  }

  // Show that the artwork really is self-contained.
  const id = Number(await nft.totalMinted());
  if (id > 0) {
    const uri = await nft.tokenURI(id);
    const meta = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString("utf8"));
    console.log(`\nToken #${id} metadata is on chain:`);
    console.log(`  name  : ${meta.name}`);
    console.log(`  image : ${meta.image.slice(0, 42)}…  (${meta.image.length} bytes, no external link)`);
  }

  // And that the gate refuses an address the identity layer does not know.
  const stranger = ethers.Wallet.createRandom().address;
  const [ok, why] = await nft.canMint(stranger);
  console.log(`\nAn unregistered address (${stranger.slice(0, 10)}…):`);
  console.log(`  canMint → ${ok}${why ? ` — "${why}"` : ""}`);

  console.log(`\nTotal minted: ${await nft.totalMinted()}`);
  console.log(`See them at /assets.html — the images are read straight from the chain.`);
}

main().catch((e) => {
  console.error("\nFailed:", explain(e));
  process.exitCode = 1;
});
