const { ethers } = require("ethers");

/**
 * Confirm the token you are about to bridge is the one you think it is.
 *
 *   node scripts/check-fuji-usdc.js
 *   CSB_FUJI_USDC=0x… CSB_EXPECT_SYMBOL=USDC node scripts/check-fuji-usdc.js
 *
 * Runs against FUJI, not CSB, so it is plain node rather than a hardhat task and
 * takes no CSB configuration at all. Read-only: it sends no transaction and needs no
 * key.
 *
 * WHY THIS IS WORTH A SCRIPT. The Home side of the bridge wraps whatever ERC-20
 * address it is given, and it will wrap the wrong one just as happily as the right
 * one. The result is a market that runs perfectly while being denominated in
 * something that is not a dollar — an error with no symptom, discovered later by
 * someone reconciling a number that never made sense. Circle's testnet deployments
 * also move, so an address that was right in a document a year ago may not be.
 *
 * What it checks, and why each one:
 *   - code exists            an EOA answers nothing and would fail confusingly later
 *   - symbol / decimals      the pair the whole market is priced against
 *   - totalSupply nonzero    a freshly deployed impostor typically has none
 *   - it is not a proxy to nothing — implementation slot, when present, has code
 */

const FUJI = process.env.CSB_FUJI_RPC ?? "https://api.avax-test.network/ext/bc/C/rpc";

// Circle's testnet USDC on Avalanche Fuji, as commonly published. NOT taken on
// trust — this script exists to check it, and the value is only a default so
// nobody has to retype it.
const DEFAULT_USDC = "0x5425890298aed601595a70AB815c96711a31Bc65";

const ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

// EIP-1967 implementation slot, for the common case of a proxied stablecoin.
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

async function main() {
  const addr = process.env.CSB_FUJI_USDC ?? DEFAULT_USDC;
  const expect = process.env.CSB_EXPECT_SYMBOL ?? "USDC";

  if (!ethers.isAddress(addr)) throw new Error(`Not a valid address: ${addr}`);

  const provider = new ethers.JsonRpcProvider(FUJI);
  let net;
  try {
    net = await provider.getNetwork();
  } catch (e) {
    throw new Error(`Cannot reach Fuji at ${FUJI}\n  ${e.shortMessage ?? e.message}\n`
      + `  If this is a sandbox or a restricted network, run it on the VM instead — `
      + `the one already running the relayer can reach Fuji by definition.`);
  }
  if (net.chainId !== 43113n) {
    console.log(`  WARNING: chainId is ${net.chainId}, expected 43113 (Fuji C-Chain).`);
  }

  console.log(`Fuji C-Chain, chainId ${net.chainId}, block ${await provider.getBlockNumber()}`);
  console.log(`Checking ${addr}\n`);

  if ((await provider.getCode(addr)).length <= 2) {
    throw new Error("No contract at that address on Fuji. Do not bridge against it.");
  }

  const t = new ethers.Contract(addr, ABI, provider);
  const [name, symbol, decimals, supply] = await Promise.all([
    t.name().catch(() => null),
    t.symbol().catch(() => null),
    t.decimals().then(Number).catch(() => null),
    t.totalSupply().catch(() => null),
  ]);

  if (symbol === null || decimals === null) {
    throw new Error("It has code but does not answer symbol()/decimals() — not an ERC-20.");
  }

  console.log(`  name        ${name}`);
  console.log(`  symbol      ${symbol}`);
  console.log(`  decimals    ${decimals}`);
  console.log(`  totalSupply ${ethers.formatUnits(supply ?? 0n, decimals)}`);

  const raw = await provider.getStorage(addr, IMPL_SLOT).catch(() => null);
  if (raw && raw !== ethers.ZeroHash) {
    const impl = ethers.getAddress("0x" + raw.slice(26));
    const implHasCode = (await provider.getCode(impl)).length > 2;
    console.log(`  proxy to    ${impl}${implHasCode ? "" : "   <-- NO CODE, broken proxy"}`);
  }

  const problems = [];
  if (symbol !== expect) problems.push(`symbol is "${symbol}", expected "${expect}"`);
  if (supply === 0n) problems.push("total supply is zero — nothing has ever been minted");

  console.log("");
  if (problems.length) {
    for (const p of problems) console.log(`  PROBLEM: ${p}`);
    console.log(`\nDo NOT bridge against this address. Find the current one from Circle's`);
    console.log(`own documentation, or from a transfer in a public explorer:`);
    console.log(`  https://testnet.snowtrace.io/token/${addr}`);
    process.exitCode = 1;
    return;
  }

  console.log(`  OK — ${symbol}, ${decimals} decimals. This is the address to give as the`);
  console.log(`  Home token in step 1 of docs/usdc-ingress.md.`);
  console.log(`\n  Cross-check it in a public explorer too, since this script only proves`);
  console.log(`  the contract answers correctly, not that Circle issued it:`);
  console.log(`    https://testnet.snowtrace.io/token/${addr}`);
}

main().catch((e) => { console.error("\n" + (e.shortMessage ?? e.message ?? e)); process.exitCode = 1; });
