const { ethers } = require("ethers");
const fs = require("fs");
const path = require("path");

/**
 * Has the bridged token arrived on CSB yet?
 *
 *   source ops/csb-env.sh
 *   node scripts/bridged-balance.js                 # the deployer
 *   node scripts/bridged-balance.js 0xSomeAddress
 *
 * Environment:
 *   CSB_BRIDGED_KEY   which deployments.json entry to read   (default "usdc")
 *
 * A cross-chain transfer completes on a different chain from the one it was sent on,
 * so there is a gap between "the transaction succeeded" and "the tokens exist". This
 * is the question to ask during that gap, and it is worth a script rather than a
 * pasted one-liner because it will be asked repeatedly and pasted one-liners are how
 * this session lost twenty minutes to an unsubstituted placeholder.
 *
 * IT REPORTS TOTAL SUPPLY AS WELL AS THE BALANCE, and the pair distinguishes two
 * failures that look identical from a single address. Supply zero means nothing has
 * been delivered at all — the relayer, or registration. Supply non-zero with a zero
 * balance means delivery worked and the tokens went somewhere else, which is a
 * recipient mistake and not an infrastructure one.
 */

const ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
];

async function main() {
  const rpc = process.env.CSB_RPC_URL;
  if (!rpc) throw new Error("Run `source ops/csb-env.sh` first — CSB_RPC_URL is not set.");

  const file = process.env.CSB_DEPLOYMENTS_FILE
    ?? path.join(__dirname, "..", "app", "deployments.json");
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const key = process.env.CSB_BRIDGED_KEY ?? "usdc";
  const rec = d.bridged?.[key];
  if (!rec?.address) throw new Error(`No bridged.${key} in deployments.json.`);

  const who = process.argv[2]
    ?? new ethers.Wallet(process.env.CSB_DEPLOYER_KEY ?? ethers.hexlify(ethers.randomBytes(32))).address;
  if (!ethers.isAddress(who)) throw new Error(`Not an address: ${who}`);

  const provider = new ethers.JsonRpcProvider(rpc);
  const t = new ethers.Contract(rec.address, ABI, provider);
  const [symbol, decimals, supply, balance] = await Promise.all([
    t.symbol().catch(() => rec.symbol ?? "?"),
    t.decimals().then(Number).catch(() => rec.decimals ?? 18),
    t.totalSupply(), t.balanceOf(who),
  ]);

  console.log(`Token   ${rec.address}  ${symbol}`);
  console.log(`Address ${who}`);
  console.log(`\n  balance       ${ethers.formatUnits(balance, decimals)} ${symbol}`);
  console.log(`  total supply  ${ethers.formatUnits(supply, decimals)} ${symbol}`);

  if (balance > 0n) {
    console.log(`\nARRIVED. The bridge works end to end.`);
    console.log(`Next: build a market against it —`);
    console.log(`  CSB_SEED_USD=20 npx hardhat run scripts/usdc-market.js --network csbRemote`);
  } else if (supply > 0n) {
    console.log(`\nDelivered, but not to this address — total supply is non-zero while this`);
    console.log(`balance is zero. That is a recipient mistake, not a relayer one. Check the`);
    console.log(`recipient given to bridge-in.js.`);
  } else {
    console.log(`\nNothing has arrived yet. Nothing has EVER arrived — total supply is zero.`);
    console.log(`If a send was mined on Fuji more than a few minutes ago, the message is not`);
    console.log(`being delivered. In order of likelihood:`);
    console.log(`  1. the relayer is not carrying Fuji -> CSB   avalanche interchain relayer logs`);
    console.log(`  2. collateral absorbed the first send — check collateralNeeded on the home`);
    console.log(`  3. delivery ran out of gas — raise CSB_REQUIRED_GAS and send again`);
  }
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
