const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Deploy a plain dollar-denominated ERC-20 on CSB, as a stand-in for a bridged one.
 *
 *   source ops/csb-env.sh
 *   npx hardhat run scripts/deploy-stand-in-usd.js --network csbRemote
 *
 * Environment, all optional:
 *   CSB_STANDIN_KEY      deployments.json key to record under   (default "usdLocal")
 *   CSB_STANDIN_SYMBOL   token symbol                              (default "USDx")
 *   CSB_STANDIN_SUPPLY   whole units to mint to the deployer      (default 100000)
 *
 * WHY THIS EXISTS, stated plainly so nobody mistakes it for the real thing.
 *
 * The second asset was wanted for three specific results: a riel-dollar pair with a
 * genuinely external reference, a SECOND Aave reserve so borrowing means posting one
 * asset against another, and liquidation demonstrated by MOVING A PRICE rather than
 * by editing a threshold. Bridging real USDC in would have supplied all three.
 * Inbound relaying is blocked in this deployment — the relayer reaches 0.000022% of
 * the stake it needs to sign a message from Fuji, measured and recorded in
 * docs/fuji-ictt.md — and that is an environment limit, not something the contracts
 * can fix.
 *
 * A locally issued token supplies all three results anyway, because none of them
 * depended on the token's provenance. What it does NOT supply is the provenance
 * itself: this is not a claim on a dollar anywhere, nobody outside this chain trades
 * it, and its price is whatever the pool was seeded at. That was already true of the
 * bridged version on this chain — docs/usdc-ingress.md says the seeded rate is
 * instrumentation and not a measurement until somebody arbitrages it — so the
 * experiments are unchanged and only the origin story differs.
 *
 * IT IS DELIBERATELY NOT CALLED USDC. Naming it USDC would put a token on chain that
 * looks like a bridged Circle dollar and is not, and that is exactly the kind of
 * thing that survives into a screenshot and then into a claim. `USDx` cannot be
 * mistaken for anything.
 *
 * IT IS UNGATED, like the bridged token it stands in for: no identity check, no
 * freeze, no confiscate. That keeps the compliance findings comparable — see
 * docs/architecture.md §7.1.
 */

const ART = require("@aave/core-v3/artifacts/contracts/mocks/tokens/MintableERC20.sol/MintableERC20.json");

async function main() {
  const { ethers } = hre;
  const provider = ethers.provider;
  const [signer] = await ethers.getSigners();

  const key = process.env.CSB_STANDIN_KEY ?? "usdLocal";
  const symbol = process.env.CSB_STANDIN_SYMBOL ?? "USDx";
  const supply = BigInt(process.env.CSB_STANDIN_SUPPLY ?? 100_000);
  const decimals = 6;                        // match USDC, so the scaling is exercised

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));

  console.log(`Chain    ${(await provider.getNetwork()).chainId}`);
  console.log(`Deployer ${signer.address}`);
  const before = await provider.getBalance(signer.address);

  if (d.bridged?.[key]?.address
      && (await provider.getCode(d.bridged[key].address)).length > 2) {
    console.log(`\nAlready deployed: ${d.bridged[key].address}`);
    console.log(`Delete bridged.${key} from deployments.json to make another.`);
    return;
  }

  console.log(`\nDeploying ${symbol} (${decimals} dp)`);
  const t = await new ethers.ContractFactory(ART.abi, ART.bytecode, signer)
    .deploy(`CSB Stand-in Dollar`, symbol, decimals);
  await t.waitForDeployment();
  const addr = await t.getAddress();
  console.log(`  ${addr}`);

  const raw = supply * 10n ** BigInt(decimals);
  await (await t.mint(raw)).wait();
  console.log(`  minted ${supply} ${symbol} to the deployer`);

  d.bridged = {
    ...(d.bridged ?? {}),
    [key]: {
      address: addr,
      symbol,
      decimals,
      name: "CSB Stand-in Dollar",
      standIn: true,
      note: "NOT BRIDGED and NOT a claim on any dollar. A locally issued token "
        + "standing in for bridged USDC, because inbound relaying is blocked in this "
        + "deployment (docs/fuji-ictt.md). Ungated, like the bridged token would be. "
        + "Its price is whatever the pool was seeded at.",
    },
  };
  fs.writeFileSync(file, JSON.stringify(d, null, 2));

  const spent = before - (await provider.getBalance(signer.address));
  console.log(`\nRecorded as bridged.${key}. Cost ${ethers.formatEther(spent)} tRIEL.`);
  console.log(`\n${"=".repeat(66)}`);
  console.log(`THIS IS NOT A BRIDGED DOLLAR. It is a local token with a dollar-ish`);
  console.log(`name, so the second-asset experiments can run. Say so wherever the`);
  console.log(`results are reported.`);
  console.log(`${"=".repeat(66)}`);
  console.log(`\nBuild the market against it:`);
  console.log(`  CSB_BRIDGED_KEY=${key} CSB_SEED_USD=1000 CSB_USD_RATE=4000 \\`);
  console.log(`    npx hardhat run scripts/usdc-market.js --network csbRemote`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
